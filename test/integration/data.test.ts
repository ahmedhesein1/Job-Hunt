import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profiles } from '../../config/profiles';
import { normalizeJob } from '../../src/core/normalize';
import { addBoard, completeBoardCheck, leaseBoard, queryDueBoards } from '../../src/data/boards';
import { ddb, tableName } from '../../src/data/client';
import { DynamoDomainGateStore } from '../../src/data/domains';
import { buildJobItem, insertJob, queryByStatus, queryDigest, transitionStatus } from '../../src/data/jobs';
import { keys } from '../../src/data/keys';
import { getNotification, jobNotificationId, markQueued, markSent, outboxPut, queryPending, putTextNotification } from '../../src/data/outbox';
import { getSettings, instantCapUpdate, setCompanyMuted } from '../../src/data/settings';
import { acquireLock, releaseLock } from '../../src/data/sources';
import { claimUpdate, reserveSendSlot } from '../../src/data/telegram-updates';
import { initialBreaker } from '../../src/scraping/circuit-breaker';
import type { ExternalJob } from '../../src/sources/contract';
import { createTestTable, dropTestTable } from './helpers';

let table: string;
beforeAll(async () => {
  table = await createTestTable();
});
afterAll(async () => dropTestTable(table));

const NOW = Date.parse('2026-11-10T08:00:00Z');
const profile = profiles[0]!;

function external(id: string): ExternalJob {
  return {
    sourceId: 'remoteok',
    sourceJobId: id,
    title: 'Backend Node.js Engineer',
    company: `Co ${id}`,
    location: 'Remote - Worldwide',
    remote: true,
    applyUrl: `https://remoteok.com/remote-jobs/${id}`,
    sourceUrl: `https://remoteok.com/remote-jobs/${id}`,
    publishedAt: new Date(NOW).toISOString(),
  };
}

async function insert(id: string, opts: { instant?: boolean; digest?: boolean } = {}) {
  const job = normalizeJob(external(id), profile, NOW);
  const delivery = opts.instant ? 'INSTANT' : opts.digest ? 'DIGEST' : 'NONE';
  const settings = await getSettings();
  const result = await insertJob({
    jobItem: buildJobItem(job, { score: 90, confidence: 0.8, matchedProfiles: ['backend-node'] }, delivery, job.jobId, NOW),
    jobId: job.jobId,
    clusterId: job.jobId,
    urlHash: `u-${id}`,
    fpHash: `f-${id}`,
    notificationPut: opts.instant ? outboxPut({ notificationId: jobNotificationId(job.jobId), kind: 'JOB', jobId: job.jobId }, NOW) : undefined,
    capUpdate: opts.instant ? instantCapUpdate('2026-11-10', settings) : undefined,
    nowMs: NOW,
  });
  return { job, result };
}

describe('job transaction (§8 step 13, must-pass 1–2)', () => {
  it('writes job + dedupe keys + outbox atomically, once', async () => {
    const { job, result } = await insert('a', { instant: true });
    expect(result).toBe('created');
    const dedupe = await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.dedupeUrl('u-a') }));
    expect(dedupe.Item?.firstJobId).toBe(job.jobId);
    const notif = await getNotification(jobNotificationId(job.jobId));
    expect(notif?.status).toBe('PENDING');
    expect((await insert('a', { instant: true })).result).toBe('exists');
    expect((await getSettings()).instantSentToday).toBe(1);
  });

  it('cap-reached cancels the whole transaction (nothing written)', async () => {
    const settings = await getSettings();
    // Force the cap to the current count.
    await ddb().send(new UpdateCommand({ TableName: tableName(), Key: keys.settings(), UpdateExpression: 'SET maxInstantAlertsPerDay = :c', ExpressionAttributeValues: { ':c': settings.instantSentToday } }));
    const { job, result } = await insert('b', { instant: true });
    expect(result).toBe('cap-reached');
    expect((await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.job(job.jobId) }))).Item).toBeUndefined();
    expect((await insert('b', { digest: true })).result).toBe('created');
    expect(await queryDigest(10)).toContain(job.jobId);
  });

  it('status transitions are conditional and recorded (GSI1)', async () => {
    const { job } = await insert('c');
    expect((await transitionStatus(job.jobId, 'Interview', NOW)).ok).toBe(false);
    expect((await transitionStatus(job.jobId, 'Saved', NOW)).ok).toBe(true);
    expect((await transitionStatus(job.jobId, 'Saved', NOW)).ok).toBe(false);
    expect((await transitionStatus(job.jobId, 'Applied', NOW + 1)).ok).toBe(true);
    const applied = await queryByStatus('Applied', '0', 10);
    expect(applied.map((j) => j.jobId)).toContain(job.jobId);
    const item = (await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.job(job.jobId) }))).Item!;
    expect(item.ttl).toBeUndefined(); // kept beyond the job TTL (§7.3)
  });
});

describe('outbox status machine (§10.1, must-pass 9)', () => {
  it('PENDING → QUEUED → SENT, and never SENT twice', async () => {
    await putTextNotification('k1', 'hello', NOW);
    const id = (await queryPending(new Date(NOW + 1000).toISOString(), 10))[0]!.notificationId;
    expect(await putTextNotification('k1', 'hello', NOW)).toBe(false);
    expect(await markQueued(id, NOW)).toBe(true);
    expect(await markQueued(id, NOW)).toBe(false);
    expect((await queryPending(new Date(NOW + 1000).toISOString(), 10)).map((p) => p.notificationId)).not.toContain(id);
    expect(await markSent(id, 99, NOW)).toBe(true);
    expect(await markSent(id, 100, NOW)).toBe(false);
    expect((await getNotification(id))?.telegramMessageId).toBe(99);
  });
});

describe('leases, idempotency and rate slots', () => {
  it('source lock is exclusive until released or expired', async () => {
    expect(await acquireLock('source:x', 'a', NOW)).toBe(true);
    expect(await acquireLock('source:x', 'b', NOW + 1000)).toBe(false);
    await releaseLock('source:x', 'b'); // not the owner: no effect
    expect(await acquireLock('source:x', 'b', NOW + 2000)).toBe(false);
    expect(await acquireLock('source:x', 'b', NOW + 10 * 60_000)).toBe(true); // expired
  });

  it('telegram update ids are claimed once (must-pass 14)', async () => {
    expect(await claimUpdate(1001, NOW)).toBe(true);
    expect(await claimUpdate(1001, NOW)).toBe(false);
  });

  it('send slots enforce the 1.1 s gap (must-pass 10)', async () => {
    expect(await reserveSendSlot('chat', NOW)).toEqual({ ok: true });
    expect(await reserveSendSlot('chat', NOW + 500)).toEqual({ ok: false, waitMs: 600 });
    expect(await reserveSendSlot('chat', NOW + 1100)).toEqual({ ok: true });
  });

  it('domain gate admits one holder per host (must-pass 8)', async () => {
    const store = new DynamoDomainGateStore();
    const results = await Promise.all(['r1', 'r2', 'r3'].map((o) => store.tryAcquire('api.example.com', o, NOW, 60_000)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = ['r1', 'r2', 'r3'][results.findIndex((r) => r.ok)]!;
    await store.release('api.example.com', winner, { nextAllowedAt: NOW + 1500, breaker: { ...initialBreaker(), status: 'MANUAL_REVIEW', pausedReason: 'HTTP 403', pausedAt: NOW } });
    const blocked = await store.tryAcquire('api.example.com', 'r4', NOW + 10 * 60_000, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.record?.breaker.status).toBe('MANUAL_REVIEW');
  });
});

describe('settings and boards', () => {
  it('mutes companies atomically', async () => {
    await setCompanyMuted('acme', 'Acme', true);
    expect((await getSettings()).mutedCompanies.has('acme')).toBe(true);
    await setCompanyMuted('acme', 'Acme', false);
    expect((await getSettings()).mutedCompanies.has('acme')).toBe(false);
  });

  it('boards: add once, due query, exclusive lease, reschedule', async () => {
    const ref = { ats: 'greenhouse' as const, token: 'acme' };
    const input = { ref, hostname: 'boards-api.greenhouse.io', addedFrom: 'test', priority: 'normal' as const, intervalMinutes: 60, firstCheckAtMs: NOW };
    expect(await addBoard(input)).toBe('added');
    expect(await addBoard(input)).toBe('exists');
    const due = await queryDueBoards(NOW + 1000, 10);
    expect(due.map((b) => b.token)).toContain('acme');
    const board = due.find((b) => b.token === 'acme')!;
    expect(await leaseBoard(board, 'o1', NOW + 1000, 60_000)).toBe(true);
    expect(await leaseBoard(board, 'o2', NOW + 2000, 60_000)).toBe(false);
    await completeBoardCheck(board, 'o1', { status: 'ACTIVE', success: true, nextIntervalMinutes: 60, consecutiveEmptyChecks: 0, stableChecks: 1 }, NOW + 3000);
    expect((await queryDueBoards(NOW + 5000, 10)).map((b) => b.token)).not.toContain('acme');
    expect((await queryDueBoards(NOW + 61 * 60_000, 10)).map((b) => b.token)).toContain('acme');
    expect((await getSettings()).activeBoards).toBe(1);
  });
});
