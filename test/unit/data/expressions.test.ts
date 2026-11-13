import { beforeAll, describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { addBoard, completeBoardCheck, leaseBoard, queryDueBoards, resumeBoard, type BoardItem } from '../../../src/data/boards';
import { setDdbClient } from '../../../src/data/client';
import { DynamoDomainGateStore, resetDomainGate } from '../../../src/data/domains';
import { attachDuplicate, digestSentUpdate, queryByStatus, queryDigest, setJobNotified, transitionStatus } from '../../../src/data/jobs';
import { markFailed, markQueued, markSent, pendingSummary, putTextNotification, queryPending, recordAttempt } from '../../../src/data/outbox';
import { instantCapUpdate, setCompanyMuted, setPaused, defaultSettings } from '../../../src/data/settings';
import { acquireLock, markAttempt, recordRun, releaseLock, resetSourceBreaker, saveSourceState, type RunSummary } from '../../../src/data/sources';
import { claimUpdate, deferSendSlot, recordSuccessfulSend, reserveSendSlot } from '../../../src/data/telegram-updates';
import { initialBreaker } from '../../../src/scraping/circuit-breaker';

/**
 * DynamoDB rejects any ExpressionAttributeValues/Names entry that no expression uses
 * (ValidationException). This records every request the data layer builds and checks
 * that rule offline, so it never reaches production again.
 */
type Input = Record<string, unknown>;
const recorded: Input[] = [];

const fakeClient = {
  send: async (command: { input: Input; constructor: { name: string } }) => {
    recorded.push(command.input);
    if (command.constructor.name === 'GetCommand') {
      return { Item: { PK: 'JOB#x', SK: 'META', jobId: 'a'.repeat(24), userStatus: 'New', discoveredAt: '2026-11-10T00:00:00Z', nextAllowedAt: 0 } };
    }
    return { Items: [], Attributes: {} };
  },
} as unknown as DynamoDBDocumentClient;

function requests(input: Input): Input[] {
  const items = input.TransactItems as Array<Record<string, Input>> | undefined;
  if (!items) return [input];
  return items.map((i) => Object.values(i)[0] as Input);
}

function unused(input: Input): string[] {
  const text = ['UpdateExpression', 'ConditionExpression', 'KeyConditionExpression', 'FilterExpression', 'ProjectionExpression']
    .map((k) => (typeof input[k] === 'string' ? (input[k] as string) : ''))
    .join(' ');
  const keys = [...Object.keys((input.ExpressionAttributeValues as object) ?? {}), ...Object.keys((input.ExpressionAttributeNames as object) ?? {})];
  // Whole-token match so ":now" is not satisfied by ":nowIso".
  return keys.filter((k) => !new RegExp(`${k.replace(/[$]/g, '\\$&')}(?![A-Za-z0-9_])`).test(text));
}

const run: RunSummary = { runId: 'r', startedAt: '2026-11-10T00:00:00Z', status: 'SUCCESS', found: 1, kept: 1, alerts: 0, digest: 0, duplicates: 0, malformed: 0, durationMs: 1 };
const board: BoardItem = {
  ats: 'greenhouse', token: 'acme', hostname: 'boards-api.greenhouse.io', nextCheckAt: '2026-11-10T00:00:00Z', intervalMinutes: 60,
  enabled: true, priority: 'normal', addedFrom: 't', status: 'ACTIVE', consecutiveEmptyChecks: 0, stableChecks: 0,
};
const NOW = 1_800_000_000_000;

beforeAll(async () => {
  setDdbClient(fakeClient);
  const breaker = initialBreaker();
  const paused = { ...breaker, status: 'MANUAL_REVIEW' as const, cooldownUntil: NOW, pausedReason: 'HTTP 403', pausedAt: NOW };

  for (const matched of [undefined, 0, 3]) {
    for (const changed of [true, false]) {
      await saveSourceState('s', { breaker, success: true, changed, matched, run }, NOW);
    }
  }
  await saveSourceState('s', { breaker: paused, success: false, changed: false, run }, NOW);
  await saveSourceState('s', { breaker, success: true, changed: true, validators: { etag: 'e' }, watermark: 1, bootstrappedAt: 'x', cursor: { a: 1 }, run }, NOW);
  await saveSourceState('s', { breaker, success: true, changed: true, validators: { lastModified: 'l' }, run }, NOW);
  await markAttempt('s', NOW);
  await resetSourceBreaker('s', breaker);
  await acquireLock('l', 'o', NOW);
  await releaseLock('l', 'o');
  await recordRun('s', run, NOW);

  await setPaused(true);
  const settings = defaultSettings();
  recorded.push(instantCapUpdate('2026-11-10', settings).Update as Input);
  recorded.push(instantCapUpdate('2026-11-10', { ...settings, day: '2026-11-10' }).Update as Input);
  await setCompanyMuted('acme', 'Acme', true);
  await setCompanyMuted('acme', 'Acme', false);

  await putTextNotification('k', 'text', NOW);
  await markQueued('n', NOW);
  await markSent('n', 1, NOW);
  await markFailed('n', 'r');
  await recordAttempt('n', 'e');
  await queryPending('2026', 10);
  await pendingSummary();

  await attachDuplicate('j', 'hn', 'https://x');
  await transitionStatus('a'.repeat(24), 'Saved', NOW);
  await transitionStatus('a'.repeat(24), 'Dismissed', NOW, 'too senior');
  recorded.push(digestSentUpdate('j', NOW).Update as Input);
  await setJobNotified('j', 1, NOW);
  await queryByStatus('New', '2026', 10);
  await queryDigest(10);

  await addBoard({ ref: { ats: 'lever', token: 't' }, hostname: 'api.lever.co', addedFrom: 'x', priority: 'low', intervalMinutes: 180, firstCheckAtMs: NOW });
  await leaseBoard(board, 'o', NOW, 1000);
  await queryDueBoards(NOW, 5);
  await resumeBoard('greenhouse', 'acme', NOW);
  const base = { status: 'ACTIVE' as const, success: true, nextIntervalMinutes: 60, consecutiveEmptyChecks: 0, stableChecks: 1 };
  await completeBoardCheck(board, 'o', base, NOW);
  await completeBoardCheck(board, 'o', { ...base, validators: { etag: 'e' }, intervalMinutes: 30, bootstrappedAt: 'x', company: 'Acme', notFoundSince: null }, NOW);
  await completeBoardCheck(board, 'o', { ...base, status: 'RETIRED', success: false, retire: true, notFoundSince: NOW }, NOW);

  const gates = new DynamoDomainGateStore();
  await gates.tryAcquire('h', 'o', NOW, 1000);
  await gates.release('h', 'o', { nextAllowedAt: NOW, breaker });
  await gates.release('h', 'o', { nextAllowedAt: NOW, breaker: paused });
  await resetDomainGate('h');

  await claimUpdate(1, NOW);
  await reserveSendSlot('c', NOW);
  await deferSendSlot('c', NOW);
  await recordSuccessfulSend('c', NOW);
});

describe('DynamoDB expressions use every supplied placeholder', () => {
  it('covers the data layer', () => expect(recorded.length).toBeGreaterThan(40));

  it('detects the production bug it guards against', () => {
    const broken = {
      UpdateExpression: 'SET zeroMatchStreak = if_not_exists(zeroMatchStreak, :zero) + :one, lastRunAt = :nowIso',
      ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':true': true, ':nowIso': 'x', ':now': 1 },
    };
    expect(unused(broken)).toEqual([':true', ':now']);
  });

  it('has no unused ExpressionAttributeValues or ExpressionAttributeNames', () => {
    const problems = recorded.flatMap(requests).flatMap((input) => {
      const bad = unused(input);
      return bad.length ? [`${String(input.UpdateExpression ?? input.KeyConditionExpression ?? input.ConditionExpression)} → unused ${bad.join(', ')}`] : [];
    });
    expect(problems).toEqual([]);
  });
});
