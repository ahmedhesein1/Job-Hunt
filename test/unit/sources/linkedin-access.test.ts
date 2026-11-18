import { beforeEach, describe, expect, it, vi } from 'vitest';
import { limits } from '../../../config/limits';
import { linkedinSearches, type LinkedInSearch } from '../../../config/linkedin-searches';
import { initialBreaker, type BreakerState } from '../../../src/scraping/circuit-breaker';
import type { ExternalJob } from '../../../src/sources/contract';
import { ProviderError, type LinkedInSearchProvider } from '../../../src/sources/linkedin/provider';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  getSourceState: vi.fn(),
  saveSourceState: vi.fn(),
  recordRun: vi.fn(),
  processJobs: vi.fn(),
  getSettings: vi.fn(),
  notifyBreakerTransition: vi.fn(),
}));
vi.mock('../../../src/data/sources', () => ({
  acquireLock: mocks.acquireLock,
  releaseLock: mocks.releaseLock,
  getSourceState: mocks.getSourceState,
  saveSourceState: mocks.saveSourceState,
  recordRun: mocks.recordRun,
}));
vi.mock('../../../src/data/settings', () => ({ getSettings: mocks.getSettings }));
vi.mock('../../../src/notifications/breaker-alert', () => ({ notifyBreakerTransition: mocks.notifyBreakerTransition }));
vi.mock('../../../src/core/pipeline', async (orig) => ({ ...(await orig<typeof import('../../../src/core/pipeline')>()), processJobs: mocks.processJobs }));

const { runCycle, dueSearches, isEgyptSearch, searchIntervalMs } = await import('../../../src/handlers/linkedin-orchestrator');

const NOW = Date.parse('2026-11-11T10:00:00Z');
const MIN = 60_000;
const job = (id: string): ExternalJob => ({ sourceId: 'linkedin-search', sourceJobId: id, title: 'Backend Engineer', company: 'Acme', applyUrl: `https://www.linkedin.com/jobs/view/${id}/`, sourceUrl: `https://www.linkedin.com/jobs/view/${id}/` });
const stats = (found: number) => ({ found, kept: found, stored: found, alerts: 0, digest: 0, duplicates: 0, malformed: 0, rejected: 0, outOfWindow: 0, boardCandidates: [] });
const state = (over: Record<string, unknown> = {}) => ({ sourceId: 'linkedin-search', breaker: initialBreaker(), bootstrappedAt: '2026-11-01T00:00:00Z', watermark: NOW - 600_000, cursor: {}, ...over });

/** In-memory seen store: `known` URLs count as processed in an earlier cycle. */
function makeSeen(known: string[] = []) {
  const set = new Set(known);
  const marked: string[] = [];
  return {
    marked,
    unseen: vi.fn(async (urls: string[]) => urls.filter((u) => !set.has(u))),
    markSeen: vi.fn(async (urls: string[]) => {
      for (const u of urls) set.add(u);
      marked.push(...urls);
    }),
  };
}

const firstDue = dueSearches(linkedinSearches, {}, NOW);
const deps = (provider: LinkedInSearchProvider | undefined, seen = makeSeen(), hostBreaker: () => Promise<BreakerState | undefined> = async () => undefined) => ({
  provider: () => provider,
  nowMs: () => NOW,
  seen,
  hostBreaker,
});

describe('due searches by date-posted window (#3)', () => {
  const egypt = linkedinSearches.filter(isEgyptSearch);
  const hour = egypt.find((s) => s.datePosted === 'past-hour')!;
  const day = egypt.find((s) => s.datePosted === 'past-24h')!;
  const week = egypt.find((s) => s.datePosted === 'past-week')!;
  const remoteDay = linkedinSearches.find((s) => !isEgyptSearch(s) && s.datePosted === 'past-24h')!;

  it('runs Egypt past-hour searches every 10 min, 24 h every 20 min and week every 6 h', () => {
    expect(searchIntervalMs(hour)).toBe(10 * MIN);
    expect(searchIntervalMs(day)).toBe(20 * MIN);
    expect(searchIntervalMs(week)).toBe(360 * MIN);
    const ran = { [hour.id]: NOW - 10 * MIN, [day.id]: NOW - 15 * MIN, [week.id]: NOW - 359.5 * MIN };
    // 24 h ran 15 min ago (not due); week is within the 1-minute slack of its 6 hours.
    expect(dueSearches([hour, day, week], ran, NOW).map((s) => s.id)).toEqual([hour.id, week.id]);
  });

  it('starts at most maxSearchesPerCycle: never-run first (shortest interval first), then the most overdue', () => {
    expect(firstDue).toHaveLength(limits.linkedinSearch.maxSearchesPerCycle);
    expect(firstDue.map((s) => s.datePosted)).toEqual(['past-hour', 'past-24h']);
    // Never-run searches compare by interval (their overdue ratios are both infinite).
    expect(dueSearches([week, day, hour], {}, NOW).map((s) => s.id)).toEqual([hour.id, day.id]);
    const ran = { [hour.id]: NOW - 1 * MIN, [week.id]: NOW - 1080 * MIN, [day.id]: NOW - 40 * MIN };
    // Week is 3 intervals overdue, 24 h 1.33; past-hour ran a minute ago.
    expect(dueSearches([day, week, hour], ran, NOW).map((s) => s.id)).toEqual([week.id, day.id]);
  });

  it('runs other searches less often: past hour every 30 min, 24 h hourly, week every 12 h', () => {
    const other = linkedinSearches.filter((s) => !isEgyptSearch(s));
    expect(searchIntervalMs(other.find((s) => s.datePosted === 'past-hour')!)).toBe(30 * MIN);
    expect(searchIntervalMs(remoteDay)).toBe(60 * MIN);
    expect(searchIntervalMs(other.find((s) => s.datePosted === 'past-week')!)).toBe(720 * MIN);
  });

  it('runs Egypt searches before the others, however overdue those are', () => {
    expect(firstDue.every(isEgyptSearch)).toBe(true);
    const ran = { [remoteDay.id]: NOW - 300 * MIN, [day.id]: NOW - 30 * MIN };
    expect(dueSearches([remoteDay, day], ran, NOW).map((s) => s.id)).toEqual([day.id, remoteDay.id]);
  });

  it('needs fewer search runs an hour than the cycles can start', () => {
    const perHour = linkedinSearches.reduce((sum, s) => sum + 60 / (searchIntervalMs(s) / MIN), 0);
    expect(perHour).toBeLessThan(limits.linkedinSearch.maxSearchesPerCycle * (60 / limits.linkedinSearch.cycleMinutes));
  });
});

describe('LinkedIn orchestrator cycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue(true);
    mocks.getSourceState.mockResolvedValue(state());
    mocks.getSettings.mockResolvedValue({});
    mocks.recordRun.mockResolvedValue(undefined);
    mocks.saveSourceState.mockResolvedValue(undefined);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.notifyBreakerTransition.mockResolvedValue(undefined);
  });

  it('without a provider: records PROVIDER_UNAVAILABLE for the due searches and stamps none as run', async () => {
    const run = await runCycle(deps(undefined));
    expect(run).toMatchObject({ status: 'FAILED', found: 0 });
    expect(run?.outcomes).toHaveLength(firstDue.length);
    expect(run?.outcomes?.every((o) => o.status === 'PROVIDER_UNAVAILABLE')).toBe(true);
    expect(mocks.processJobs).not.toHaveBeenCalled();
    expect(mocks.saveSourceState).toHaveBeenCalledWith('linkedin-search', expect.objectContaining({ success: false, watermark: undefined, cursor: {} }), NOW);
    expect(mocks.recordRun).toHaveBeenCalledOnce();
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it('processes only jobs not seen before, marks them seen, and stamps completed searches', async () => {
    mocks.processJobs.mockResolvedValue(stats(2));
    const [a, b] = [firstDue[0]!, firstDue[1]!];
    const seen = makeSeen([job('old').sourceUrl]);
    const provider: LinkedInSearchProvider = {
      id: 'test',
      concurrency: 4,
      search: async (s) => {
        if (s.id === a.id) return [job('1'), job('old')];
        throw new ProviderError('TRANSIENT', '503 Service Unavailable');
      },
    };
    const run = await runCycle(deps(provider, seen));
    expect(run?.status).toBe('SUCCESS');
    expect(mocks.processJobs).toHaveBeenCalledWith([job('1')], expect.objectContaining({ bootstrapped: true }));
    expect(seen.marked).toEqual([job('1').sourceUrl]);
    expect(run?.outcomes?.find((o) => o.id === b.id)).toMatchObject({ status: 'FAILED', attempts: limits.linkedinSearch.maxRetries + 1 });
    const saved = mocks.saveSourceState.mock.calls[0]![1] as { cursor: Record<string, number>; success: boolean };
    expect(saved.success).toBe(true);
    expect(saved.cursor[a.id]).toBe(NOW);
    expect(saved.cursor[b.id]).toBeUndefined(); // failed: stays due for the next cycle
    expect(Object.keys(saved.cursor)).toHaveLength(firstDue.length - 1);
  });

  it('keeps jobs that failed to store unseen so they are retried', async () => {
    mocks.processJobs.mockImplementation(async (jobs: ExternalJob[], ctx: { onOutcome: (o: object) => void }) => {
      ctx.onOutcome({ sourceJobId: '1', title: '', company: '', result: 'malformed', explanation: 'processing failed' });
      return stats(jobs.length);
    });
    const seen = makeSeen();
    await runCycle(deps({ id: 'test', concurrency: 1, search: async (s) => (s.id === firstDue[0]!.id ? [job('1'), job('2')] : []) }, seen));
    expect(seen.marked).toEqual([job('2').sourceUrl]);
  });

  it('completes new jobs with the provider before the pipeline (#4)', async () => {
    mocks.processJobs.mockResolvedValue(stats(1));
    const enrich = vi.fn(async (jobs: ExternalJob[]) => ({ jobs: jobs.map((j) => ({ ...j, description: 'Node.js role' })), fetched: jobs.length, failed: 0 }));
    const seen = makeSeen([job('old').sourceUrl]);
    const run = await runCycle(deps({ id: 'test', concurrency: 1, search: async (s) => (s.id === firstDue[0]!.id ? [job('1'), job('old')] : []), enrich }, seen));
    expect(enrich).toHaveBeenCalledWith([job('1')], expect.any(AbortSignal));
    expect(mocks.processJobs).toHaveBeenCalledWith([{ ...job('1'), description: 'Node.js role' }], expect.anything());
    expect(run?.detail).toContain('1 descriptions');
  });

  it('a block stops the cycle, is recorded as FAILED and stamps nothing', async () => {
    const search = vi.fn(async () => {
      throw new ProviderError('BLOCKED', 'access denied: permission required');
    });
    const run = await runCycle(deps({ id: 'test', concurrency: 1, search }));
    expect(run?.status).toBe('FAILED');
    expect(run?.detail).toContain(`1 BLOCKED, ${firstDue.length - 1} PROVIDER_STOPPED`);
    expect(search).toHaveBeenCalledOnce();
    expect(mocks.saveSourceState).toHaveBeenCalledWith('linkedin-search', expect.objectContaining({ success: false, cursor: {} }), NOW);
  });

  it('an unreadable results page pauses the source for review and alerts (#1)', async () => {
    const provider: LinkedInSearchProvider = {
      id: 'test',
      concurrency: 1,
      search: async () => {
        throw new ProviderError('BAD_CONTENT', 'linkedin: results page has no recognisable job cards (5000 bytes); layout changed?');
      },
    };
    const run = await runCycle(deps(provider));
    expect(run?.outcomes?.[0]?.status).toBe('UNPARSEABLE');
    expect(run?.detail).toContain('paused: linkedin: results page has no recognisable job cards');
    const saved = mocks.saveSourceState.mock.calls[0]![1] as { breaker: { status: string }; success: boolean };
    expect(saved).toMatchObject({ success: false, breaker: { status: 'MANUAL_REVIEW' } });
    expect(mocks.notifyBreakerTransition).toHaveBeenCalledOnce();
  });

  it('too many unreadable cards pause the source too (#1)', async () => {
    const provider: LinkedInSearchProvider = { id: 'test', concurrency: 1, search: async () => [], searched: () => 4, malformed: () => 8 };
    const run = await runCycle(deps(provider));
    expect(run).toMatchObject({ malformed: 8 });
    expect(run?.detail).toContain('paused: 8/12 job cards unreadable');
    expect(mocks.notifyBreakerTransition).toHaveBeenCalledOnce();
  });

  it('does not run while the source is paused for review', async () => {
    mocks.getSourceState.mockResolvedValue(state({ breaker: { ...initialBreaker(), status: 'MANUAL_REVIEW', pausedReason: 'unexpected content (layout)' } }));
    const search = vi.fn(async () => []);
    const run = await runCycle(deps({ id: 'test', concurrency: 1, search }));
    expect(run).toMatchObject({ status: 'DEFERRED', detail: 'breaker MANUAL_REVIEW: unexpected content (layout)' });
    expect(search).not.toHaveBeenCalled();
    expect(mocks.saveSourceState).not.toHaveBeenCalled();
  });

  it('runs only due searches, using the stored last-run times', async () => {
    const ranRecently = Object.fromEntries(linkedinSearches.map((s) => [s.id, NOW - 9.5 * MIN]));
    mocks.getSourceState.mockResolvedValue(state({ cursor: ranRecently }));
    const searched: LinkedInSearch[] = [];
    const run = await runCycle(deps({ id: 'test', concurrency: 1, search: async (s) => (searched.push(s), []) }));
    // Ran 9.5 minutes ago: only Egypt past-hour searches (10-minute interval, 1-minute slack) are due.
    const expected = linkedinSearches.filter((s) => isEgyptSearch(s) && s.datePosted === 'past-hour');
    expect(searched.map((s) => s.id)).toEqual(expected.slice(0, limits.linkedinSearch.maxSearchesPerCycle).map((s) => s.id));
    expect(run?.status).toBe('SUCCESS');
  });

  it('waits while linkedin.com cools down after a rate limit: no request, nothing stamped', async () => {
    const cooling: BreakerState = { ...initialBreaker(), status: 'COOLDOWN', consecutive429: 3, cooldownUntil: Date.parse('2026-11-11T11:00:00Z') };
    const search = vi.fn(async () => []);
    const run = await runCycle(deps({ id: 'test', concurrency: 1, search }, makeSeen(), async () => cooling));
    // 11:00 UTC is 13:00 in Cairo (UTC+2 in November).
    expect(run).toMatchObject({ status: 'DEFERRED', detail: 'linkedin.com rate limit (3× in a row): cooling down until 13:00 Cairo' });
    expect(search).not.toHaveBeenCalled();
    expect(mocks.saveSourceState).not.toHaveBeenCalled();
    expect(mocks.recordRun).toHaveBeenCalledOnce();
  });

  it('runs once the cooldown has passed', async () => {
    const cooled: BreakerState = { ...initialBreaker(), status: 'COOLDOWN', consecutive429: 1, cooldownUntil: NOW - 1 };
    const search = vi.fn(async () => []);
    const run = await runCycle(deps({ id: 'test', concurrency: 1, search }, makeSeen(), async () => cooled));
    expect(search).toHaveBeenCalled();
    expect(run?.status).toBe('SUCCESS');
  });

  it('does not overlap cycles', async () => {
    mocks.acquireLock.mockResolvedValue(false);
    expect(await runCycle(deps(undefined))).toBeUndefined();
    expect(mocks.saveSourceState).not.toHaveBeenCalled();
  });
});
