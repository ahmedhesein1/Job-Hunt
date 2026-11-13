import { describe, expect, it } from 'vitest';
import { sources } from '../../../config/sources';
import { processJobs, windowStart } from '../../../src/core/pipeline';
import { defaultSettings, type Settings } from '../../../src/data/settings';
import { decideDelivery } from '../../../src/notifications/queue';
import type { ExternalJob } from '../../../src/sources/contract';
import { FakeStore } from '../../helpers/fake-store';

// 10:00 Cairo on a weekday — outside quiet hours.
const NOW = Date.parse('2026-11-10T08:00:00Z');
const DESC =
  'Build backend APIs with Node.js, TypeScript, NestJS, PostgreSQL and Redis on AWS with Docker. 2+ years of experience required. ' +
  'You will design services, write tests and work with product. Fully remote, open worldwide. '.repeat(2);

function job(id: string, overrides: Partial<ExternalJob> = {}): ExternalJob {
  return {
    sourceId: 'remoteok',
    sourceJobId: id,
    title: 'Backend Node.js Engineer',
    company: `Company ${id}`,
    location: 'Remote - Worldwide',
    remote: true,
    description: DESC,
    descriptionIsHtml: false,
    applyUrl: `https://remoteok.com/remote-jobs/${id}`,
    sourceUrl: `https://remoteok.com/remote-jobs/${id}`,
    publishedAt: new Date(NOW - 3_600_000).toISOString(),
    ...overrides,
  };
}

function ctx(settings: Settings = defaultSettings(), bootstrapped = true) {
  return { policy: sources.remoteok, settings, bootstrapped, sinceMs: NOW - 7 * 86_400_000, nowMs: NOW };
}

describe('pipeline must-pass scenarios (§16)', () => {
  it('1. a new qualifying job is saved once with one outbox item', async () => {
    const store = new FakeStore();
    const stats = await processJobs([job('1')], ctx(), store);
    expect(stats).toMatchObject({ stored: 1, alerts: 1 });
    expect(store.jobs.size).toBe(1);
    expect(store.outbox.size).toBe(1);
  });

  it('2. reprocessing the same item creates no second job or alert', async () => {
    const store = new FakeStore();
    await processJobs([job('1')], ctx(), store);
    const again = await processJobs([job('1'), job('1')], ctx(), store);
    expect(again.stored).toBe(0);
    expect(store.jobs.size).toBe(1);
    expect(store.outbox.size).toBe(1);
  });

  it('3. cross-source duplicates merge only with strong evidence', async () => {
    const store = new FakeStore();
    const employer = 'https://jobs.lever.co/acme/0f8f2b1c-1111-2222-3333-444455556666';
    await processJobs([job('1', { company: 'Acme', employerUrl: employer })], ctx(), store);
    // Same canonical employer URL from another source → duplicate, no alert.
    const hn = await processJobs(
      [job('hn-9', { sourceId: 'hn', company: 'Acme Inc.', employerUrl: `${employer}/apply?lever-source=hn`, sourceUrl: 'https://news.ycombinator.com/item?id=9', applyUrl: employer })],
      { ...ctx(), policy: sources.hn },
      store,
    );
    expect(hn.duplicates).toBe(1);
    expect(store.attached).toEqual([{ jobId: expect.any(String), sourceId: 'hn' }]);
  });

  it('3b. fingerprint matches need a second signal (§9)', async () => {
    const store = new FakeStore();
    const reposted = (id: string, overrides: Partial<ExternalJob>) => job(id, { company: 'Beta', ...overrides });
    await processJobs([reposted('a', { requisitionId: 'R-1' })], ctx(), store);
    // Same company/title/scope + same requisition → duplicate.
    expect((await processJobs([reposted('b', { requisitionId: 'R-1' })], ctx(), store)).duplicates).toBe(1);
    // Same company/title/scope but a different requisition → a different posting, stored.
    expect((await processJobs([reposted('c', { requisitionId: 'R-2' })], ctx(), store)).stored).toBe(1);

    const store2 = new FakeStore();
    const firstSeen = new Date(NOW - 20 * 86_400_000).toISOString();
    await processJobs([job('x', { company: 'Gamma', publishedAt: firstSeen })], { ...ctx(), sinceMs: 0 }, store2);
    // Published 20 days apart with no requisition IDs → not merged.
    expect((await processJobs([job('y', { company: 'Gamma' })], ctx(), store2)).stored).toBe(1);
    // Within two weeks of the posting that owns the fingerprint key (x) → merged.
    const nearX = new Date(NOW - 10 * 86_400_000).toISOString();
    expect((await processJobs([job('z', { company: 'Gamma', publishedAt: nearX })], { ...ctx(), sinceMs: 0 }, store2)).duplicates).toBe(1);
  });

  it('4. first source run stores jobs but sends no alerts', async () => {
    const store = new FakeStore();
    const stats = await processJobs([job('1'), job('2'), job('3')], ctx(defaultSettings(), false), store);
    expect(stats.stored).toBe(3);
    expect(stats.alerts).toBe(0);
    expect(store.outbox.size).toBe(0);
  });

  it('instant cap overflow goes to the digest, not dropped (§10.4)', async () => {
    const store = new FakeStore();
    store.capRemaining = 1;
    const stats = await processJobs([job('1'), job('2')], ctx(), store);
    expect(stats.alerts).toBe(1);
    expect(stats.digest).toBe(1);
    expect(store.jobs.size).toBe(2);
  });

  it('skips items outside the window and counts malformed ones', async () => {
    const store = new FakeStore();
    const stats = await processJobs(
      [job('old', { publishedAt: new Date(NOW - 30 * 86_400_000).toISOString() }), { ...job('bad'), title: '' }],
      ctx(),
      store,
    );
    expect(stats.outOfWindow).toBe(1);
    expect(stats.malformed).toBe(1);
  });

  it('collects ATS board candidates only from sources that allow discovery', async () => {
    const employer = 'https://boards.greenhouse.io/acme/jobs/123';
    const ro = await processJobs([job('1', { employerUrl: employer })], ctx(), new FakeStore());
    expect(ro.boardCandidates).toHaveLength(0);
    const hn = await processJobs([job('1', { sourceId: 'hn', employerUrl: employer })], { ...ctx(), policy: sources.hn }, new FakeStore());
    expect(hn.boardCandidates).toEqual([expect.objectContaining({ ats: 'greenhouse', token: 'acme' })]);
  });
});

describe('delivery policy (§10.4)', () => {
  const base = { score: 85, confidence: 0.8, publishedAt: new Date(NOW - 3_600_000).toISOString(), publishedAtReliable: true, bootstrapped: true };
  it('instant for ≥80 outside quiet hours', () => expect(decideDelivery(base, defaultSettings(), NOW)).toBe('INSTANT'));
  it('digest during quiet hours (00:00–08:00 Cairo)', () => {
    const night = Date.parse('2026-11-10T01:00:00Z'); // 03:00 Cairo
    expect(decideDelivery({ ...base, publishedAt: new Date(night - 3_600_000).toISOString() }, defaultSettings(), night)).toBe('DIGEST');
  });
  it('digest when paused, for 60–79, none below 60 or low confidence', () => {
    expect(decideDelivery(base, { ...defaultSettings(), paused: true }, NOW)).toBe('DIGEST');
    expect(decideDelivery({ ...base, score: 70 }, defaultSettings(), NOW)).toBe('DIGEST');
    expect(decideDelivery({ ...base, score: 59 }, defaultSettings(), NOW)).toBe('NONE');
    expect(decideDelivery({ ...base, confidence: 0.3 }, defaultSettings(), NOW)).toBe('NONE');
  });
  it('stale listings are not alerted unless publishedAt is unreliable', () => {
    const old = new Date(NOW - 4 * 86_400_000).toISOString();
    expect(decideDelivery({ ...base, publishedAt: old }, defaultSettings(), NOW)).toBe('NONE');
    expect(decideDelivery({ ...base, publishedAt: old, publishedAtReliable: false }, defaultSettings(), NOW)).toBe('INSTANT');
  });
  it('window start uses bootstrap backfill or watermark overlap', () => {
    expect(windowStart(false, undefined, NOW)).toBe(NOW - 7 * 86_400_000);
    expect(windowStart(true, NOW, NOW)).toBe(NOW - 48 * 3_600_000);
  });
});
