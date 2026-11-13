import type { Context } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { limits } from '../../config/limits';
import { sources, watchlistBoards } from '../../config/sources';
import { processJobs, emptyStats, type PipelineStats } from '../core/pipeline';
import { addDiscoveredBoards } from '../core/board-discovery';
import { stableId } from '../core/url';
import { addBoard, boardRef, completeBoardCheck, leaseBoard, queryDueBoards, type BoardCheckUpdate, type BoardItem } from '../data/boards';
import { ddb, tableName } from '../data/client';
import { DynamoDomainGateStore } from '../data/domains';
import { keys } from '../data/keys';
import { getSettings, type Settings } from '../data/settings';
import { getSourceState, recordRun, saveSourceState, type RunSummary } from '../data/sources';
import { logger } from '../lib/logger';
import { DAY_MS, MINUTE_MS } from '../lib/time';
import { DomainGate, GateClosedError } from '../scraping/domain-gate';
import { Fetcher, SourceHttpError } from '../scraping/fetcher';
import { boardApiHost, fetchBoard } from '../sources/ats/common';
import { notifyBreakerTransition } from './sync-source';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { withUsage } from '../lib/usage';

const policy = sources['company-boards'];
const BOARD_LEASE_MS = 3 * MINUTE_MS;

/** Seeds config/sources.ts watchlist boards once per config change. */
async function seedWatchlist(nowMs: number): Promise<void> {
  const hash = stableId(JSON.stringify(watchlistBoards));
  const current = await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.settings(),
      UpdateExpression: 'SET watchlistHash = :h, entity = :e',
      ConditionExpression: 'attribute_not_exists(watchlistHash) OR watchlistHash <> :h',
      ExpressionAttributeValues: { ':h': hash, ':e': 'SETTINGS' },
    }),
  ).then(
    () => true,
    (err: unknown) => {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw err;
    },
  );
  if (!current) return;
  for (const board of watchlistBoards) {
    const ref = { ats: board.ats, token: board.token, company: board.company };
    const result = await addBoard({
      ref,
      hostname: boardApiHost(ref),
      addedFrom: 'watchlist',
      priority: board.priority,
      intervalMinutes: intervalForPriority(board.priority) ?? limits.boards.defaultIntervalMinutes,
      firstCheckAtMs: nowMs,
    });
    if (result === 'cap-reached') break;
  }
}

/** Fixed cadence for curated boards; only auto-discovered ('low') boards age out. */
export function intervalForPriority(priority: BoardItem['priority']): number | undefined {
  if (priority === 'high') return limits.boards.highPriorityIntervalMinutes;
  if (priority === 'normal') return limits.boards.defaultIntervalMinutes;
  return undefined;
}

export function nextInterval(board: Pick<BoardItem, 'priority' | 'intervalMinutes' | 'consecutiveEmptyChecks'>, kept: number): { interval: number; empty: number } {
  const empty = kept > 0 ? 0 : board.consecutiveEmptyChecks + 1;
  const fixed = intervalForPriority(board.priority);
  if (fixed !== undefined) return { interval: fixed, empty };
  // Discovered boards that keep returning nothing useful: double the interval, bounded;
  // any match brings them back to the discovery cadence.
  let interval = board.intervalMinutes;
  if (empty > 0 && empty % limits.boards.emptyChecksBeforeSlowdown === 0) interval = Math.min(limits.boards.maxIntervalMinutes, interval * 2);
  if (kept > 0) interval = Math.min(interval, limits.boards.discoveredIntervalMinutes);
  return { interval, empty };
}

interface BoardRunResult {
  stats: PipelineStats;
  success: boolean;
}

async function checkBoard(board: BoardItem, fetcher: Fetcher, owner: string, settings: Settings, nowMs: number): Promise<BoardRunResult> {
  const ref = boardRef(board);
  const label = `${board.ats}/${board.token}`;
  const base: Pick<BoardCheckUpdate, 'consecutiveEmptyChecks' | 'stableChecks'> = {
    consecutiveEmptyChecks: board.consecutiveEmptyChecks,
    stableChecks: board.stableChecks,
  };
  try {
    const result = await fetchBoard(fetcher, ref, { etag: board.etag, lastModified: board.lastModified });
    if (result.kind === 'unchanged' || result.kind === 'skipped') {
      // 304: nothing new on this board, which counts as an empty check.
      const stable = board.stableChecks + 1;
      const { interval, empty } = nextInterval(board, 0);
      await completeBoardCheck(
        board,
        owner,
        { status: 'ACTIVE', success: true, nextIntervalMinutes: interval, intervalMinutes: interval, consecutiveEmptyChecks: empty, stableChecks: stable, notFoundSince: null },
        nowMs,
      );
      return { stats: emptyStats(), success: true };
    }
    if (result.kind !== 'ok') throw new Error('unexpected board result');
    const bootstrapped = Boolean(board.bootstrappedAt);
    const lastSuccess = board.lastSuccessAt ? Date.parse(board.lastSuccessAt) : undefined;
    const sinceMs =
      bootstrapped && lastSuccess ? lastSuccess - limits.sync.watermarkOverlapMs : nowMs - limits.sync.bootstrapBackfillDays * DAY_MS;
    // A new board bootstraps silently: its existing postings are history, not news.
    const stats = await processJobs(result.jobs, { policy, settings, bootstrapped, sinceMs, nowMs });
    stats.malformed += result.malformed;
    const stable = board.stableChecks + 1;
    const { interval, empty } = nextInterval(board, stats.kept);
    await completeBoardCheck(
      board,
      owner,
      {
        status: 'ACTIVE',
        success: true,
        validators: result.validators,
        nextIntervalMinutes: interval,
        intervalMinutes: interval,
        bootstrappedAt: bootstrapped ? undefined : new Date(nowMs).toISOString(),
        consecutiveEmptyChecks: empty,
        stableChecks: stable,
        notFoundSince: null,
        company: board.company ? undefined : result.jobs[0]?.company,
      },
      nowMs,
    );
    return { stats, success: true };
  } catch (err) {
    if (err instanceof GateClosedError) {
      // Host busy or cooling down: try again when the gate opens.
      const retryInMin = err.retryAt ? Math.max(1, Math.ceil((err.retryAt - nowMs) / MINUTE_MS)) : 1;
      await completeBoardCheck(board, owner, { ...base, status: board.status, success: false, nextIntervalMinutes: retryInMin }, nowMs);
      return { stats: emptyStats(), success: false };
    }
    const outcome = err instanceof SourceHttpError ? err.outcome : undefined;
    if (outcome?.type === 'NOT_FOUND') {
      const since = board.notFoundSince ?? nowMs;
      const retire = nowMs - since >= limits.boards.notFoundRetireAfterMs;
      await completeBoardCheck(
        board,
        owner,
        { ...base, status: retire ? 'RETIRED' : 'UNAVAILABLE', success: false, nextIntervalMinutes: 24 * 60, notFoundSince: since, retire },
        nowMs,
      );
      logger.info('board not found', { board: label, retire });
      return { stats: emptyStats(), success: false };
    }
    if (outcome && ['FORBIDDEN', 'CHALLENGE', 'AUTH', 'CLIENT_BUG', 'BAD_CONTENT'].includes(outcome.type)) {
      // Stop automatic attempts; a person must review (§5.5). Host-level blocks are also
      // paused on the domain gate and reported from there.
      await completeBoardCheck(board, owner, { ...base, status: 'MANUAL_REVIEW', success: false, nextIntervalMinutes: 7 * 24 * 60 }, nowMs);
      if (outcome.type === 'CLIENT_BUG' || outcome.type === 'BAD_CONTENT') {
        await notifyBreakerTransition(`Board ${label}`, { from: 'CLOSED', to: 'MANUAL_REVIEW', message: `paused for manual review: ${outcome.type}` }, nowMs);
      }
      return { stats: emptyStats(), success: false };
    }
    // Transient / rate limited / parse errors: back off to the normal interval; the
    // domain gate breaker handles host-level cooldowns.
    logger.warn('board check failed', { board: label, outcome: outcome?.type, error: err });
    await completeBoardCheck(board, owner, { ...base, status: board.status, success: false, nextIntervalMinutes: board.intervalMinutes }, nowMs);
    return { stats: emptyStats(), success: false };
  }
}

function merge(into: PipelineStats, from: PipelineStats): void {
  for (const k of ['found', 'kept', 'stored', 'alerts', 'digest', 'duplicates', 'malformed', 'rejected', 'outOfWindow'] as const) into[k] += from[k];
  into.boardCandidates.push(...from.boardCandidates);
}

async function handle(_event: unknown, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<RunSummary | undefined> {
  if (!policy.enabled) return undefined;
  const runId = randomUUID();
  const startedAt = Date.now();
  const remaining = () => context?.getRemainingTimeInMillis() ?? Number.POSITIVE_INFINITY;
  await seedWatchlist(startedAt);
  const settings = await getSettings();

  const due = await queryDueBoards(startedAt, limits.boards.batchSize);
  if (due.length === 0) return undefined;

  const gate = new DomainGate(new DynamoDomainGateStore(), runId);
  const fetcher = new Fetcher(gate);
  const total = emptyStats();
  let succeeded = 0;
  let checked = 0;

  // One sequential lane per ATS host: never more than one in-flight request per host,
  // while different hosts proceed in parallel (§4.2).
  const lanes = new Map<string, BoardItem[]>();
  for (const board of due) lanes.set(board.hostname, [...(lanes.get(board.hostname) ?? []), board]);
  await Promise.all(
    [...lanes.values()].map(async (lane) => {
      for (const board of lane) {
        if (remaining() < limits.boards.minRemainingMs) break;
        const nowMs = Date.now();
        if (!(await leaseBoard(board, runId, nowMs, BOARD_LEASE_MS))) continue;
        checked += 1;
        const result = await checkBoard(board, fetcher, runId, settings, nowMs);
        merge(total, result.stats);
        if (result.success) succeeded += 1;
      }
    }),
  );

  for (const t of gate.transitions) await notifyBreakerTransition(`Host ${t.hostname}`, t, Date.now());
  if (total.boardCandidates.length > 0) await addDiscoveredBoards(total.boardCandidates, `company-boards:${runId}`, startedAt);

  const run: RunSummary = {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    status: succeeded > 0 ? 'SUCCESS' : checked > 0 ? 'FAILED' : 'DEFERRED',
    found: total.found,
    kept: total.kept,
    alerts: total.alerts,
    digest: total.digest,
    duplicates: total.duplicates,
    malformed: total.malformed,
    durationMs: Date.now() - startedAt,
    detail: `${checked}/${due.length} boards checked, ${succeeded} ok`,
  };
  const state = await getSourceState('company-boards');
  await saveSourceState('company-boards', { breaker: state.breaker, success: succeeded > 0, changed: total.found > 0, matched: succeeded > 0 ? total.kept : undefined, run }, Date.now());
  await recordRun('company-boards', run, Date.now());
  logger.info('board batch complete', { ...run });
  return run;
}

/** §9: usage counters (HTTP, Telegram) are flushed once per invocation. */
export const handler = withUsage(handle);
