import { randomUUID } from 'node:crypto';
import { limits } from '../../config/limits';
import { linkedinSearches, type LinkedInSearch } from '../../config/linkedin-searches';
import { sources } from '../../config/sources';
import { PROCESSING_FAILED, processJobs, windowStart, type PipelineStats } from '../core/pipeline';
import { dynamoSeenStore, type SeenStore } from '../data/seen';
import { getSettings } from '../data/settings';
import { acquireLock, getSourceState, recordRun, releaseLock, saveSourceState, type RunSummary } from '../data/sources';
import { logger } from '../lib/logger';
import { withUsage } from '../lib/usage';
import { notifyBreakerTransition } from '../notifications/breaker-alert';
import { applyOutcome, isBlocked } from '../scraping/circuit-breaker';
import type { ExternalJob } from '../sources/contract';
import { runSearchCycle, summarize, type CycleResult } from '../sources/linkedin/orchestrator';
import { linkedinProvider, type EnrichResult, type LinkedInSearchProvider } from '../sources/linkedin/provider';

const policy = sources['linkedin-search'];
const LOCK = 'source:linkedin-search';

export interface OrchestratorDeps {
  provider: (cycleId: string) => LinkedInSearchProvider | undefined | Promise<LinkedInSearchProvider | undefined>;
  nowMs: () => number;
  /** Jobs processed in an earlier cycle (only new ones go through the pipeline). */
  seen: Pick<SeenStore, 'unseen' | 'markSeen'>;
}

const defaultDeps: OrchestratorDeps = { provider: linkedinProvider, nowMs: Date.now, seen: dynamoSeenStore };

/** How often a search runs, from its date-posted window. */
export function searchIntervalMs(search: LinkedInSearch): number {
  return limits.linkedinSearch.searchIntervalMinutes[search.datePosted ?? 'any'] * 60_000;
}

/**
 * The searches due this cycle (interval elapsed, less `dueSlackMs`), most overdue first
 * (never-run ones first, then shorter intervals), at most `maxSearchesPerCycle`.
 * `lastRun` holds each search's last completed run (epoch ms) by search ID.
 */
export function dueSearches(searches: readonly LinkedInSearch[], lastRun: Readonly<Record<string, string | number>>, nowMs: number): LinkedInSearch[] {
  const elapsed = (s: LinkedInSearch) => {
    const last = Number(lastRun[s.id]);
    return Number.isFinite(last) && last > 0 ? nowMs - last : Number.POSITIVE_INFINITY;
  };
  return searches
    .map((search, index) => ({ search, index, interval: searchIntervalMs(search), elapsed: elapsed(search) }))
    .filter((s) => s.elapsed >= s.interval - limits.linkedinSearch.dueSlackMs)
    .sort((a, b) => b.elapsed / b.interval - a.elapsed / a.interval || a.interval - b.interval || a.index - b.index)
    .slice(0, limits.linkedinSearch.maxSearchesPerCycle)
    .map(({ search }) => search);
}

/** Last-run times after this cycle: searches that completed (any result) are stamped. */
function nextLastRun(previous: Readonly<Record<string, string | number>>, result: CycleResult, startedAt: number): Record<string, number> {
  const known = new Set(linkedinSearches.map((s) => s.id));
  const next: Record<string, number> = {};
  for (const [id, at] of Object.entries(previous)) if (known.has(id) && Number.isFinite(Number(at))) next[id] = Number(at);
  for (const o of result.outcomes) if (o.status === 'SUCCESS' || o.status === 'NO_RESULTS') next[o.id] = startedAt;
  return next;
}

function runStatus(result: CycleResult): RunSummary['status'] {
  return result.outcomes.some((o) => o.status === 'SUCCESS' || o.status === 'NO_RESULTS') ? 'SUCCESS' : 'FAILED';
}

/** Reason to pause the source for review: an unreadable page, or too many unreadable cards. */
function contentProblem(result: CycleResult): string | undefined {
  const unparseable = result.outcomes.find((o) => o.status === 'UNPARSEABLE');
  if (unparseable) return unparseable.detail ?? 'results page not understood';
  const malformed = result.malformed ?? 0;
  const total = (result.searched ?? 0) + malformed;
  if (total >= 10 && malformed / total > limits.linkedinSearch.maxMalformedRatio) return `${malformed}/${total} job cards unreadable`;
  return undefined;
}

/** Jobs among `jobs` not processed in an earlier cycle; on a store error, all of them. */
async function newJobsOnly(jobs: ExternalJob[], seen: OrchestratorDeps['seen']): Promise<ExternalJob[]> {
  if (jobs.length === 0) return [];
  try {
    const fresh = new Set(await seen.unseen(jobs.map((j) => j.sourceUrl)));
    return jobs.filter((j) => fresh.has(j.sourceUrl));
  } catch (err) {
    // The pipeline's own dedupe still prevents duplicate alerts.
    logger.warn('linkedin seen lookup failed; processing all jobs', { error: err });
    return jobs;
  }
}

/**
 * One 3-minute cycle over the saved LinkedIn searches that are due (one schedule, one
 * invocation). Overlapping cycles are prevented with a lease. Only jobs not seen in an
 * earlier cycle are completed with their job page and go through the pipeline; searches
 * that fail or miss the deadline stay due and run again next cycle.
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
  const summaryOf = (status: RunSummary['status'], detail: string, stats?: Partial<PipelineStats>, extra?: Partial<RunSummary>): RunSummary => ({
    runId: cycleId,
    startedAt: new Date(startedAt).toISOString(),
    status,
    found: stats?.found ?? 0,
    kept: stats?.kept ?? 0,
    alerts: stats?.alerts ?? 0,
    digest: stats?.digest ?? 0,
    duplicates: stats?.duplicates ?? 0,
    malformed: stats?.malformed ?? 0,
    durationMs: deps.nowMs() - startedAt,
    detail,
    ...extra,
  });
  try {
    const state = await getSourceState(policy.id);
    // Paused for review (e.g. LinkedIn changed its page layout): nothing runs until /resume.
    if (isBlocked(state.breaker, startedAt)) {
      run = summaryOf('DEFERRED', `breaker ${state.breaker.status}${state.breaker.pausedReason ? `: ${state.breaker.pausedReason}` : ''}`);
      return run;
    }
    const lastRun = state.cursor ?? {};
    const due = dueSearches(linkedinSearches, lastRun, startedAt);
    if (due.length === 0) {
      run = summaryOf('SKIPPED', 'no search due');
      return run;
    }

    const provider = await deps.provider(cycleId);
    const result = await runSearchCycle(due, provider, {
      concurrency: limits.linkedinSearch.concurrency,
      deadlineMs: startedAt + limits.linkedinSearch.deadlineMs,
      maxRetries: limits.linkedinSearch.maxRetries,
      backoffBaseMs: limits.linkedinSearch.backoffBaseMs,
      // The deadline is computed from this clock, so the cycle must use the same one.
      now: deps.nowMs,
    });

    // Only jobs not processed before: completed with their job page, then the pipeline.
    const fresh = await newJobsOnly(result.jobs, deps.seen);
    let enriched: EnrichResult = { jobs: fresh, fetched: 0, failed: 0 };
    const detailBudgetMs = startedAt + limits.linkedinSearch.detailDeadlineMs - deps.nowMs();
    if (provider?.enrich && fresh.length > 0 && detailBudgetMs > 0) {
      enriched = await provider.enrich(fresh, AbortSignal.timeout(detailBudgetMs));
    }

    const bootstrapped = Boolean(state.bootstrappedAt);
    let stats: PipelineStats | undefined;
    const failed = new Set<string>();
    if (enriched.jobs.length > 0) {
      stats = await processJobs(enriched.jobs, {
        policy,
        settings: await getSettings(),
        bootstrapped,
        sinceMs: windowStart(bootstrapped, state.watermark, startedAt),
        nowMs: startedAt,
        onOutcome: (o) => {
          if (o.explanation === PROCESSING_FAILED) failed.add(o.sourceJobId);
        },
      });
      // Remember processed jobs; ones that failed to store stay new and are retried.
      const done = enriched.jobs.filter((j) => !failed.has(j.sourceJobId)).map((j) => j.sourceUrl);
      if (done.length > 0) await deps.seen.markSeen(done, deps.nowMs()).catch((err: unknown) => logger.warn('linkedin markSeen failed', { error: err }));
    }

    const counts = summarize(result.outcomes);
    const status = runStatus(result);
    const problem = contentProblem(result);
    let breaker = state.breaker;
    if (problem) {
      const applied = applyOutcome(state.breaker, { type: 'BAD_CONTENT', detail: problem }, deps.nowMs());
      breaker = applied.state;
      if (applied.transition) await notifyBreakerTransition(policy.name, applied.transition, deps.nowMs());
      logger.warn('linkedin results not understood; source paused for review', { cycleId, problem });
    }
    const pipeline = { ...(stats ?? {}), malformed: (stats?.malformed ?? 0) + (result.malformed ?? 0), duplicates: (stats?.duplicates ?? 0) + result.duplicates };
    const parts = [
      `${result.outcomes.length} due searches: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`,
      `${result.searched ?? 0} cards, ${result.jobs.length} jobs, ${fresh.length} new`,
      enriched.fetched + enriched.failed > 0 ? `${enriched.fetched} descriptions${enriched.failed ? ` (${enriched.failed} failed)` : ''}` : undefined,
      (result.malformed ?? 0) > 0 ? `${result.malformed} unreadable cards` : undefined,
      enriched.stoppedBy ? `details stopped: ${enriched.stoppedBy}` : undefined,
      problem ? `paused: ${problem}` : undefined,
    ].filter(Boolean);
    run = summaryOf(status, `${parts.join(' | ')}${result.provider ? ` via ${result.provider}` : ''}`, pipeline, { outcomes: result.outcomes });
    await saveSourceState(
      policy.id,
      {
        breaker,
        success: status === 'SUCCESS' && !problem,
        changed: (stats?.stored ?? 0) > 0,
        watermark: status === 'SUCCESS' ? startedAt : undefined,
        bootstrappedAt: status === 'SUCCESS' && !bootstrapped ? new Date(startedAt).toISOString() : undefined,
        matched: status === 'SUCCESS' ? (stats?.kept ?? 0) : undefined,
        cursor: nextLastRun(lastRun, result, startedAt),
        run,
      },
      deps.nowMs(),
    );
    logger.info('linkedin cycle complete', {
      cycleId,
      status,
      counts,
      due: due.length,
      cards: result.searched,
      jobs: result.jobs.length,
      new: fresh.length,
      descriptions: enriched.fetched,
      malformed: result.malformed,
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
