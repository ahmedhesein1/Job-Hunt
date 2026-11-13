import { beforeEach, describe, expect, it, vi } from 'vitest';
import { limits } from '../../../config/limits';
import { linkedinSearches } from '../../../config/linkedin-searches';

const N = linkedinSearches.length;
import { ProviderError, type LinkedInSearchProvider } from '../../../src/sources/linkedin/provider';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  getSourceState: vi.fn(),
  saveSourceState: vi.fn(),
  recordRun: vi.fn(),
  processJobs: vi.fn(),
  getSettings: vi.fn(),
  recordSearchMatches: vi.fn(),
}));
vi.mock('../../../src/data/sources', () => ({
  acquireLock: mocks.acquireLock,
  releaseLock: mocks.releaseLock,
  getSourceState: mocks.getSourceState,
  saveSourceState: mocks.saveSourceState,
  recordRun: mocks.recordRun,
}));
vi.mock('../../../src/data/settings', () => ({ getSettings: mocks.getSettings }));
vi.mock('../../../src/core/pipeline', async (orig) => ({ ...(await orig<typeof import('../../../src/core/pipeline')>()), processJobs: mocks.processJobs }));

const { runCycle } = await import('../../../src/handlers/linkedin-orchestrator');

const NOW = Date.parse('2026-11-11T10:00:00Z');
const job = (id: string) => ({ sourceId: 'linkedin-search' as const, sourceJobId: id, title: 'Backend Engineer', company: 'Acme', applyUrl: `https://www.linkedin.com/jobs/view/${id}/`, sourceUrl: `https://www.linkedin.com/jobs/view/${id}/` });
const stats = (found: number) => ({ found, kept: found, stored: found, alerts: 0, digest: 0, duplicates: 0, malformed: 0, rejected: 0, outOfWindow: 0, boardCandidates: [] });

describe('LinkedIn orchestrator run records (§3: never report a skipped search as successful)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue(true);
    mocks.getSourceState.mockResolvedValue({ sourceId: 'linkedin-search', breaker: { status: 'CLOSED' }, bootstrappedAt: '2026-11-01T00:00:00Z', watermark: NOW - 600_000 });
    mocks.getSettings.mockResolvedValue({});
    mocks.recordRun.mockResolvedValue(undefined);
    mocks.saveSourceState.mockResolvedValue(undefined);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.recordSearchMatches.mockResolvedValue(true);
  });

  it('without a provider: records PROVIDER_UNAVAILABLE for every search, nothing processed', async () => {
    const run = await runCycle({ provider: () => undefined, nowMs: () => NOW, recordSearchMatches: mocks.recordSearchMatches });
    expect(run).toMatchObject({ status: 'FAILED', found: 0, detail: `${N} searches: ${N} PROVIDER_UNAVAILABLE` });
    expect(run?.outcomes).toHaveLength(N);
    expect(mocks.processJobs).not.toHaveBeenCalled();
    expect(mocks.saveSourceState).toHaveBeenCalledWith('linkedin-search', expect.objectContaining({ success: false, watermark: undefined }), NOW);
    expect(mocks.recordRun).toHaveBeenCalledOnce();
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it('records fetched jobs and failed searches separately', async () => {
    mocks.processJobs.mockResolvedValue(stats(2));
    const provider: LinkedInSearchProvider = {
      id: 'test',
      concurrency: 4,
      search: async (s) => {
        if (s.id === 'backend-egypt-24h') return [job('1'), job('2')];
        if (s.id === 'nestjs-egypt-24h') throw new ProviderError('TRANSIENT', '503 Service Unavailable');
        return [];
      },
    };
    const run = await runCycle({ provider: () => provider, nowMs: () => NOW, recordSearchMatches: mocks.recordSearchMatches });
    expect(run?.status).toBe('SUCCESS');
    expect(run?.found).toBe(2);
    expect(run?.detail).toContain(`${N - 2} NO_RESULTS`);
    expect(run?.detail).toContain('1 SUCCESS');
    expect(run?.detail).toContain('1 FAILED');
    expect(run?.outcomes?.find((o) => o.id === 'nestjs-egypt-24h')).toMatchObject({ status: 'FAILED', attempts: limits.linkedinSearch.maxRetries + 1, detail: '503 Service Unavailable' });
    expect(run?.outcomes?.find((o) => o.id === 'backend-egypt-24h')).toMatchObject({ status: 'SUCCESS', found: 2 });
    expect(mocks.processJobs).toHaveBeenCalledWith([job('1'), job('2')], expect.objectContaining({ bootstrapped: true }));
    expect(mocks.saveSourceState).toHaveBeenCalledWith('linkedin-search', expect.objectContaining({ success: true }), NOW);
  });

  it('marks a cycle where the provider is blocked as FAILED with the reason, and stops', async () => {
    const search = vi.fn(async () => {
      throw new ProviderError('BLOCKED', 'access denied: permission required');
    });
    const run = await runCycle({ provider: () => ({ id: 'test', concurrency: 1, search }), nowMs: () => NOW, recordSearchMatches: mocks.recordSearchMatches });
    expect(run?.status).toBe('FAILED');
    expect(run?.detail).toBe(`${N} searches: 1 BLOCKED, ${N - 1} PROVIDER_STOPPED via test`);
    expect(search).toHaveBeenCalledOnce();
    expect(mocks.saveSourceState).toHaveBeenCalledWith('linkedin-search', expect.objectContaining({ success: false }), NOW);
  });

  it('tags jobs already stored by their collector instead of processing them again', async () => {
    const stored = { ...job('9'), sourceId: 'company-boards' as const, storedJobId: 'job-9', matchedSearches: ['Egypt · Backend · 24 h'] };
    const provider: LinkedInSearchProvider = { id: 'stored', concurrency: 4, search: async (s) => (s.id === 'backend-egypt-24h' || s.id === 'nestjs-egypt-24h' ? [{ ...stored, matchedSearches: [s.label] }] : []), searched: () => 7 };
    const run = await runCycle({ provider: () => provider, nowMs: () => NOW, recordSearchMatches: mocks.recordSearchMatches });
    expect(mocks.processJobs).not.toHaveBeenCalled();
    expect(mocks.recordSearchMatches).toHaveBeenCalledOnce();
    expect(mocks.recordSearchMatches).toHaveBeenCalledWith('job-9', expect.arrayContaining(['Egypt · Backend · 24 h', 'Egypt · Node.js / NestJS · 24 h']));
    expect(run?.detail).toMatch(/| 7 new job(s) searched, 1 matched, 1 newly tagged via stored$/);
  });

  it('reads only the window since the previous cycle (minus the overlap)', async () => {
    const seen: number[] = [];
    await runCycle({ provider: (ctx) => { seen.push(ctx.sinceMs); return undefined; }, nowMs: () => NOW, recordSearchMatches: mocks.recordSearchMatches });
    expect(seen).toEqual([NOW - 600_000 - 4 * 60_000]);
  });

  it('does not overlap cycles', async () => {
    mocks.acquireLock.mockResolvedValue(false);
    expect(await runCycle({ provider: () => undefined, nowMs: () => NOW, recordSearchMatches: mocks.recordSearchMatches })).toBeUndefined();
    expect(mocks.saveSourceState).not.toHaveBeenCalled();
  });
});
