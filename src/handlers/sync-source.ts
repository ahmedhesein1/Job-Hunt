import { randomUUID } from 'node:crypto';
import { limits } from '../../config/limits';
import { isSyncableSourceId, sources, type SyncableSourceId } from '../../config/sources';
import { addDiscoveredBoards } from '../core/board-discovery';
import { processJobs, windowStart, type PipelineStats } from '../core/pipeline';
import { DynamoDomainGateStore } from '../data/domains';
import { putTextNotification } from '../data/outbox';
import { getSettings } from '../data/settings';
import {
  acquireLock,
  getSourceState,
  markAttempt,
  recordRun,
  releaseLock,
  saveSourceState,
  type RunSummary,
} from '../data/sources';
import { logger } from '../lib/logger';
import { MINUTE_MS } from '../lib/time';
import { escapeHtml } from '../notifications/formatting';
import { notifyBreakerTransition } from '../notifications/breaker-alert';
import { applyOutcome, isBlocked } from '../scraping/circuit-breaker';
import { DomainGate, GateClosedError } from '../scraping/domain-gate';
import { Fetcher, SourceHttpError } from '../scraping/fetcher';
import type { Outcome } from '../scraping/retry-policy';
import type { FetchResult, SourceAdapter } from '../sources/contract';
import { himalayasAdapter } from '../sources/himalayas';
import { hnAdapter } from '../sources/hn';
import { jobicyAdapter } from '../sources/jobicy';
import { remoteOkAdapter } from '../sources/remoteok';
import { wuzzufAdapter } from '../sources/wuzzuf-rss';
import { careerPagesAdapter } from '../sources/career-pages';
import { linkedInSnapshotAdapter } from '../sources/linkedin/snapshot-import';
import { dynamoSeenStore } from '../data/seen';
import { cairoDayKey } from '../lib/time';
import { withUsage } from '../lib/usage';

export const ADAPTERS: Record<SyncableSourceId, SourceAdapter> = {
  himalayas: himalayasAdapter,
  remoteok: remoteOkAdapter,
  wuzzuf: wuzzufAdapter,
  jobicy: jobicyAdapter,
  hn: hnAdapter,
  'linkedin-snapshot': linkedInSnapshotAdapter,
  'career-pages': careerPagesAdapter,
  // Rendered pages run in the separate browser function (sync-rendered-pages).
  'career-pages-js': { id: 'career-pages-js', fetch: async () => ({ kind: 'skipped', reason: 'runs in the browser function' }) },
};

function summary(runId: string, startedAt: number, status: RunSummary['status'], stats?: PipelineStats, detail?: string): RunSummary {
  return {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    status,
    found: stats?.found ?? 0,
    kept: stats?.kept ?? 0,
    alerts: stats?.alerts ?? 0,
    digest: stats?.digest ?? 0,
    duplicates: stats?.duplicates ?? 0,
    malformed: stats?.malformed ?? 0,
    durationMs: Date.now() - startedAt,
    detail,
  };
}

/** One source run, §8 steps 1–15. */
export async function runSource(sourceId: SyncableSourceId, overrides: Partial<Record<SyncableSourceId, SourceAdapter>> = {}): Promise<RunSummary> {
  const policy = sources[sourceId];
  const runId = randomUUID();
  const startedAt = Date.now();
  if (!policy.enabled) {
    logger.info('source disabled; skipping', { sourceId, reason: policy.disabledReason });
    return summary(runId, startedAt, 'SKIPPED', undefined, 'disabled');
  }

  const lockName = `source:${sourceId}`;
  // Step 1: lease. Another valid lease means another run is active: exit without fetching.
  if (!(await acquireLock(lockName, runId, startedAt))) {
    logger.info('source run already in progress', { sourceId });
    return summary(runId, startedAt, 'SKIPPED', undefined, 'locked');
  }

  let run: RunSummary | undefined;
  try {
    // Step 2: manual pause / cooldown / minimum interval.
    const state = await getSourceState(sourceId);
    if (isBlocked(state.breaker, startedAt)) {
      run = summary(runId, startedAt, 'DEFERRED', undefined, `breaker ${state.breaker.status}`);
      return run;
    }
    const minInterval = policy.minIntervalMinutes * state.breaker.intervalMultiplier * MINUTE_MS;
    if (state.lastAttemptAt !== undefined && startedAt - state.lastAttemptAt < minInterval) {
      run = summary(runId, startedAt, 'SKIPPED', undefined, 'minimum interval not reached');
      return run;
    }
    await markAttempt(sourceId, startedAt);

    const bootstrapped = Boolean(state.bootstrappedAt);
    const sinceMs = windowStart(bootstrapped, state.watermark, startedAt);
    // Steps 3–6: domain gate + policy-compliant fetch.
    const fetcher = new Fetcher(new DomainGate(new DynamoDomainGateStore(), runId));
    let result: FetchResult;
    try {
      result = await (overrides[sourceId] ?? ADAPTERS[sourceId]).fetch({
        fetcher,
        policy,
        validators: { etag: state.etag, lastModified: state.lastModified },
        sinceMs,
        cursor: state.cursor,
        nowMs: startedAt,
        seen: dynamoSeenStore,
      });
    } catch (err) {
      if (err instanceof GateClosedError) {
        run = summary(runId, startedAt, 'DEFERRED', undefined, `domain gate ${err.reason}`);
        return run;
      }
      const outcome: Outcome = err instanceof SourceHttpError ? err.outcome : { type: 'TRANSIENT', detail: `adapter error: ${(err as Error).message}` };
      const applied = applyOutcome(state.breaker, outcome, Date.now());
      run = summary(runId, startedAt, 'FAILED', undefined, outcome.type);
      await saveSourceState(sourceId, { breaker: applied.state, success: false, changed: false, run }, Date.now());
      if (applied.transition) await notifyBreakerTransition(policy.name, applied.transition, Date.now());
      logger.warn('source run failed', { sourceId, outcome: outcome.type, error: err });
      return run;
    }

    if (result.kind === 'skipped') {
      run = summary(runId, startedAt, 'SKIPPED', undefined, result.reason);
      return run;
    }
    if (result.kind === 'unchanged') {
      // §5.3: a 304 is a successful unchanged check — no parsing, no job writes.
      const applied = applyOutcome(state.breaker, { type: 'NOT_MODIFIED' }, Date.now());
      run = summary(runId, startedAt, 'UNCHANGED');
      await saveSourceState(sourceId, { breaker: applied.state, success: true, changed: false, validators: result.validators, run }, Date.now());
      if (applied.transition) await notifyBreakerTransition(policy.name, applied.transition, Date.now());
      return run;
    }

    // Step 7: bounded malformed-item threshold.
    if (result.seen > 0 && result.malformed / result.seen > limits.sync.maxMalformedRatio) {
      const outcome: Outcome = { type: 'BAD_CONTENT', detail: `${result.malformed}/${result.seen} items malformed` };
      const applied = applyOutcome(state.breaker, outcome, Date.now());
      run = summary(runId, startedAt, 'FAILED', undefined, outcome.detail);
      await saveSourceState(sourceId, { breaker: applied.state, success: false, changed: false, run }, Date.now());
      if (applied.transition) await notifyBreakerTransition(policy.name, applied.transition, Date.now());
      return run;
    }

    // Steps 8–13.
    const settings = await getSettings();
    const stats = await processJobs(result.jobs, { policy, settings, bootstrapped, sinceMs, nowMs: startedAt });
    stats.malformed += result.malformed;
    if (stats.boardCandidates.length > 0) await addDiscoveredBoards(stats.boardCandidates, `${sourceId}:${runId}`, startedAt);

    // Step 14.
    const applied = applyOutcome(state.breaker, { type: 'OK' }, Date.now());
    run = summary(runId, startedAt, 'SUCCESS', stats);
    const watermark = Math.max(state.watermark ?? 0, stats.newestPublishedMs ?? 0) || undefined;
    await saveSourceState(
      sourceId,
      {
        breaker: applied.state,
        success: true,
        changed: true,
        validators: result.validators,
        watermark,
        bootstrappedAt: bootstrapped ? undefined : new Date(startedAt).toISOString(),
        cursor: result.cursor,
        matched: stats.kept,
        run,
      },
      Date.now(),
    );
    if (applied.transition) await notifyBreakerTransition(policy.name, applied.transition, Date.now());
    // Per-site problems in multi-site sources: at most one message per problem per day.
    for (const warning of result.warnings ?? []) {
      await putTextNotification(`warn:${sourceId}:${warning}:${cairoDayKey(startedAt)}`, `⚠️ <b>${escapeHtml(policy.name)}</b>: ${escapeHtml(warning)}`, Date.now());
    }

    // Bootstrap: one connection summary instead of an alert flood (§8, §10.4).
    if (!bootstrapped) {
      await putTextNotification(
        `bootstrap:${sourceId}`,
        `🔌 <b>${escapeHtml(policy.name)}</b> connected: ${stats.stored} matching job${stats.stored === 1 ? '' : 's'} from the last ${limits.sync.bootstrapBackfillDays} days stored. Use /top to see them. New matches will alert from now on.`,
        Date.now(),
      );
    }
    logger.info('source run complete', { sourceId, ...run });
    return run;
  } finally {
    if (run) await recordRun(sourceId, run, Date.now()).catch((err: unknown) => logger.error('recordRun failed', { error: err }));
    // Step 15: always release our lease.
    await releaseLock(lockName, runId);
  }
}

async function handle(event: { sourceId?: unknown }): Promise<RunSummary> {
  if (!isSyncableSourceId(event.sourceId)) throw new Error(`Unknown sourceId: ${String(event.sourceId)}`);
  return runSource(event.sourceId);
}

/** §9: usage counters (HTTP, Telegram) are flushed once per invocation. */
export const handler = withUsage(handle);
