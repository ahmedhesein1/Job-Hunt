import { beforeEach, describe, expect, it, vi } from 'vitest';
import { linkedinSearches, type LinkedInSearch } from '../../../config/linkedin-searches';
import { countHttp, countHttpBytes, countUsage, resetUsage, usageSnapshot, usageUpdate } from '../../../src/lib/usage';
import { runSearchCycle, summarize } from '../../../src/sources/linkedin/orchestrator';
import { ProviderError, type LinkedInSearchProvider } from '../../../src/sources/linkedin/provider';
import type { ExternalJob } from '../../../src/sources/contract';

describe('usage counters', () => {
  beforeEach(() => resetUsage());

  it('aggregates requests and bytes per host', () => {
    countHttp('himalayas.app');
    countHttpBytes('himalayas.app', 1_000);
    countHttp('himalayas.app', 500);
    countUsage('telegramSent');
    countUsage('telegramSent', 0); // ignored
    expect(usageSnapshot()).toEqual({
      totals: { httpRequests: 2, httpBytes: 1_500, telegramSent: 1 },
      hosts: { 'himalayas.app': { requests: 2, bytes: 1_500 } },
    });
  });

  it('builds one atomic ADD per invocation, with names escaped', () => {
    countHttp('api.lever.co', 10);
    const update = usageUpdate('2026-11-11', Date.parse('2026-11-11T10:00:00Z'));
    expect(update?.Key).toEqual({ PK: 'USAGE#2026-11-11', SK: 'APP' });
    expect(update?.UpdateExpression).toMatch(/^SET entity = :e, #ttl = :ttl ADD /);
    expect(Object.values(update?.ExpressionAttributeNames ?? {})).toEqual(expect.arrayContaining(['httpRequests', 'req#api.lever.co', 'bytes#api.lever.co', 'ttl']));
  });

  it('writes nothing when nothing was counted', () => {
    expect(usageUpdate('2026-11-11', 0)).toBeUndefined();
  });
});

const job = (id: string): ExternalJob => ({ sourceId: 'linkedin-search', sourceJobId: id, title: 'Backend Engineer', company: 'Acme', applyUrl: `https://www.linkedin.com/jobs/view/${id}/`, sourceUrl: `https://www.linkedin.com/jobs/view/${id}/` });

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

describe('LinkedIn search cycle (§3, §4)', () => {
  const opts = (clock: ReturnType<typeof fakeClock>, extra = {}) => ({ concurrency: 4, deadlineMs: clock.now() + 45_000, maxRetries: 2, backoffBaseMs: 1_000, now: clock.now, sleep: clock.sleep, random: () => 0.5, ...extra });

  it('records an outcome for every saved search when no provider is authorized', async () => {
    const clock = fakeClock();
    const r = await runSearchCycle(linkedinSearches, undefined, opts(clock));
    expect(r.outcomes).toHaveLength(linkedinSearches.length);
    expect(new Set(r.outcomes.map((o) => o.id))).toEqual(new Set(linkedinSearches.map((s) => s.id)));
    expect(summarize(r.outcomes)).toEqual({ PROVIDER_UNAVAILABLE: linkedinSearches.length });
    expect(r.outcomes[0]?.detail).toBe("no search provider configured");
  });

  it('runs every search with bounded concurrency and one job per ID across searches', async () => {
    const clock = fakeClock();
    let inFlight = 0;
    let peak = 0;
    const provider: LinkedInSearchProvider = {
      id: 'fake',
      concurrency: 3,
      search: async (s: LinkedInSearch) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return [job('1'), job(`only-${s.id}`)];
      },
    };
    const r = await runSearchCycle(linkedinSearches, provider, opts(clock));
    expect(peak).toBeLessThanOrEqual(3);
    expect(summarize(r.outcomes)).toEqual({ SUCCESS: linkedinSearches.length });
    expect(r.jobs).toHaveLength(linkedinSearches.length + 1); // job "1" from every search counted once
    expect(r.duplicates).toBe(linkedinSearches.length - 1);
  });

  it('retries transient errors with backoff and isolates a failing search', async () => {
    const clock = fakeClock();
    const calls = new Map<string, number>();
    const provider: LinkedInSearchProvider = {
      id: 'fake',
      concurrency: 1,
      search: async (s) => {
        calls.set(s.id, (calls.get(s.id) ?? 0) + 1);
        if (s.id === 'b' && calls.get('b')! < 3) throw new ProviderError('TRANSIENT', '503');
        if (s.id === 'c') throw new Error('socket hang up');
        return [];
      },
    };
    const searches = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, keywords: id }));
    const r = await runSearchCycle(searches, provider, opts(clock));
    expect(r.outcomes.map((o) => [o.id, o.status, o.attempts])).toEqual([
      ['a', 'NO_RESULTS', 1],
      ['b', 'NO_RESULTS', 3],
      ['c', 'FAILED', 3],
      ['d', 'NO_RESULTS', 1],
    ]);
  });

  it('stops the provider on a block and never retries it', async () => {
    const clock = fakeClock();
    const search = vi.fn(async (s: LinkedInSearch) => {
      if (s.id === 'b') throw new ProviderError('BLOCKED', 'challenge page');
      return [];
    });
    const searches = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, keywords: id }));
    const r = await runSearchCycle(searches, { id: 'fake', concurrency: 1, search }, opts(clock));
    expect(r.outcomes.map((o) => o.status)).toEqual(['NO_RESULTS', 'BLOCKED', 'PROVIDER_STOPPED', 'PROVIDER_STOPPED']);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['AUTH', 'AUTH_REQUIRED'],
    ['RATE_LIMITED', 'RATE_LIMITED'],
  ] as const)('treats %s as stopping, not retryable', async (kind, status) => {
    const clock = fakeClock();
    const r = await runSearchCycle([{ id: 'a', label: 'a', keywords: 'a' }, { id: 'b', label: 'b', keywords: 'b' }], { id: 'f', concurrency: 1, search: async () => { throw new ProviderError(kind, 'x'); } }, opts(clock));
    expect(r.outcomes.map((o) => o.status)).toEqual([status, 'PROVIDER_STOPPED']);
    expect(r.outcomes[0]?.attempts).toBe(1);
  });

  it('enforces the cycle deadline; unfinished searches are left for the next cycle', async () => {
    const clock = fakeClock();
    const provider: LinkedInSearchProvider = { id: 'slow', concurrency: 1, search: async () => { clock.advance(20_000); return []; } };
    const searches = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, keywords: id }));
    const r = await runSearchCycle(searches, provider, opts(clock));
    expect(r.outcomes.map((o) => o.status)).toEqual(['NO_RESULTS', 'NO_RESULTS', 'NO_RESULTS', 'DEADLINE']);
  });
});
