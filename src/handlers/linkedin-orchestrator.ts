import { randomUUID } from 'node:crypto';
import { limits } from '../../config/limits';
import { linkedinSearches } from '../../config/linkedin-searches';
import { sources } from '../../config/sources';
import { processJobs, windowStart } from '../core/pipeline';
import { recordSearchMatches } from '../data/jobs';
import { getSettings } from '../data/settings';
import { acquireLock, getSourceState, recordRun, releaseLock, saveSourceState, type RunSummary } from '../data/sources';
import { logger } from '../lib/logger';
import { withUsage } from '../lib/usage';
import { runSearchCycle, summarize, type CycleResult } from '../sources/linkedin/orchestrator';
import { linkedinProvider, type LinkedInSearchProvider, type ProviderContext } from '../sources/linkedin/provider';

const policy = sources['linkedin-search'];
const LOCK = 'source:linkedin-search';

export interface OrchestratorDeps {
  provider: (ctx: ProviderContext, cycleId: string) => LinkedInSearchProvider | undefined | Promise<LinkedInSearchProvider | undefined>;
  nowMs: () => number;
  recordSearchMatches: (jobId: string, labels: string[]) => Promise<boolean>;
}

const defaultDeps: OrchestratorDeps = { provider: linkedinProvider, nowMs: Date.now, recordSearchMatches };

/**
 * The saved searches starting at a per-cycle offset. A cycle may end at its deadline
 * before every search ran; rotating the start makes each search lead a cycle at least once
 * every `rotateOverCycles` cycles instead of the last ones never running.
 */
export function rotatedSearches<T>(searches: readonly T[], startedAtMs: number): T[] {
  if (searches.length === 0) return [];
  const cycleIndex = Math.floor(startedAtMs / (limits.linkedinSearch.cycleMinutes * 60_000));
  const step = Math.ceil(searches.length / limits.linkedinSearch.rotateOverCycles);
  const offset = (cycleIndex * step) % searches.length;
  return [...searches.slice(offset), ...searches.slice(0, offset)];
}

function runStatus(result: CycleResult): RunSummary['status'] {
  return result.outcomes.some((o) => o.status === 'SUCCESS' || o.status === 'NO_RESULTS') ? 'SUCCESS' : 'FAILED';
}

/**
 * One 3-minute cycle over all saved LinkedIn searches (one schedule, one invocation, not
 * one function per search). Overlapping cycles are prevented with a lease; searches that
 * fail or miss the deadline are simply attempted again next cycle.
 */
export async function runCycle(deps: OrchestratorDeps = defaultDeps): Promise<RunSummary | undefined> {
  const startedAt = deps.nowMs();
  const cycleId = randomUUID();
  const leaseMs = limits.linkedinSearch.cycleMinutes * 60_000 - 10_000;
  if (!(await acquireLock(LOCK, cycleId, startedAt, leaseMs))) {
    logger.info('linkedin cycle skipped: previous cycle still running', { cycleId });
    return undefined;
  }
  let run: RunSummary | undefined;
  try {
    const state = await getSourceState(policy.id);
    // Read only what was stored since the previous cycle. The overlap covers collectors that
    // stamp discovery time at the start of a run but write up to ~3 minutes later.
    const sinceMs = state.watermark !== undefined ? state.watermark - limits.linkedinSearch.windowOverlapMs : startedAt - limits.linkedinSearch.firstWindowMs;
    const result = await runSearchCycle(rotatedSearches(linkedinSearches, startedAt), await deps.provider({ sinceMs, nowMs: startedAt }, cycleId), {
      concurrency: limits.linkedinSearch.concurrency,
      deadlineMs: startedAt + limits.linkedinSearch.deadlineMs,
      maxRetries: limits.linkedinSearch.maxRetries,
      backoffBaseMs: limits.linkedinSearch.backoffBaseMs,
      // The deadline is computed from this clock, so the cycle must use the same one.
      now: deps.nowMs,
    });

    let stats = { found: 0, kept: 0, alerts: 0, digest: 0, duplicates: 0, malformed: 0, stored: 0 };
    const bootstrapped = Boolean(state.bootstrappedAt);
    // Jobs already stored by their own collector are tagged, never processed again.
    const stored = result.jobs.filter((j) => j.storedJobId);
    const fresh = result.jobs.filter((j) => !j.storedJobId);
    let tagged = 0;
    for (const job of stored) {
      try {
        if (await deps.recordSearchMatches(job.storedJobId!, job.matchedSearches ?? [])) tagged += 1;
      } catch (err) {
        logger.warn('recording search matches failed', { jobId: job.storedJobId, error: err });
      }
    }
    if (fresh.length > 0) {
      stats = await processJobs(fresh, {
        policy,
        settings: await getSettings(),
        bootstrapped,
        sinceMs: windowStart(bootstrapped, state.watermark, startedAt),
        nowMs: startedAt,
      });
    }
    stats.duplicates += result.duplicates;

    const counts = summarize(result.outcomes);
    const status = runStatus(result);
    run = {
      runId: cycleId,
      startedAt: new Date(startedAt).toISOString(),
      status,
      found: stats.found,
      kept: stats.kept,
      alerts: stats.alerts,
      digest: stats.digest,
      duplicates: stats.duplicates,
      malformed: stats.malformed,
      durationMs: deps.nowMs() - startedAt,
      detail: `${result.outcomes.length} searches: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}${result.searched !== undefined ? ` | ${result.searched} new job(s) searched, ${stored.length} matched, ${tagged} newly tagged` : ''}${result.provider ? ` via ${result.provider}` : ''}`,
      outcomes: result.outcomes,
    };
    await saveSourceState(
      policy.id,
      {
        breaker: state.breaker,
        success: status === 'SUCCESS',
        changed: stats.stored > 0,
        watermark: status === 'SUCCESS' ? startedAt : undefined,
        bootstrappedAt: status === 'SUCCESS' && !bootstrapped ? new Date(startedAt).toISOString() : undefined,
        matched: status === 'SUCCESS' ? stats.kept : undefined,
        run,
      },
      deps.nowMs(),
    );
    logger.info('linkedin cycle complete', {
      cycleId,
      status,
      counts,
      jobs: result.jobs.length,
      searched: result.searched,
      matched: stored.length,
      tagged,
      durationMs: run.durationMs,
    });
    return run;
  } finally {
    if (run) await recordRun(policy.id, run, deps.nowMs()).catch((err: unknown) => logger.warn('recordRun failed', { error: err }));
    await releaseLock(LOCK, cycleId);
  }
}

async function handle(): Promise<RunSummary | undefined> {
  return runCycle();
}

/** §9: usage counters are flushed once per invocation. */
export const handler = withUsage(handle);
