import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { limits } from '../../config/limits';
import { initialBreaker, type BreakerState } from '../scraping/circuit-breaker';
import type { Validators } from '../sources/contract';
import { ttlAfterDays } from '../lib/time';
import { ddb, isConditionalCheckFailed, tableName } from './client';
import { keys } from './keys';

/** §7 `SOURCE#<id>` / `STATE`. Timestamps are epoch ms. */
export interface SourceState {
  sourceId: string;
  watermark?: number | undefined;
  etag?: string | undefined;
  lastModified?: string | undefined;
  bootstrappedAt?: string | undefined;
  lastAttemptAt?: number | undefined;
  lastSuccessAt?: number | undefined;
  lastChangeAt?: number | undefined;
  consecutiveFailures: number;
  pausedUntil?: number | undefined;
  /** Breaker status mirrored as `state` for /status. */
  state: BreakerState['status'];
  breaker: BreakerState;
  cursor: Record<string, string | number>;
  /** Consecutive successful checks that produced zero matches (§13 health). */
  zeroMatchStreak: number;
  /** True once the source has produced matches at least once. */
  hasProducedMatches: boolean;
  lastRun?: RunSummary | undefined;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  status: 'SUCCESS' | 'UNCHANGED' | 'DEFERRED' | 'SKIPPED' | 'FAILED';
  found: number;
  kept: number;
  alerts: number;
  digest: number;
  duplicates: number;
  malformed: number;
  durationMs: number;
  detail?: string | undefined;
  /** Per-search results for multi-search sources (LinkedIn searches). */
  outcomes?: Array<{ id: string; status: string; ms: number; attempts: number; found?: number | undefined; detail?: string | undefined }> | undefined;
}

export async function getSourceState(sourceId: string): Promise<SourceState> {
  const result = await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.sourceState(sourceId), ConsistentRead: true }));
  return toSourceState(sourceId, result.Item);
}

export function toSourceState(sourceId: string, item: Record<string, unknown> | undefined): SourceState {
  const breaker = (item?.breaker as BreakerState | undefined) ?? initialBreaker();
  return {
    sourceId,
    watermark: item?.watermark as number | undefined,
    etag: item?.etag as string | undefined,
    lastModified: item?.lastModified as string | undefined,
    bootstrappedAt: item?.bootstrappedAt as string | undefined,
    lastAttemptAt: item?.lastAttemptAt as number | undefined,
    lastSuccessAt: item?.lastSuccessAt as number | undefined,
    lastChangeAt: item?.lastChangeAt as number | undefined,
    consecutiveFailures: Number(item?.consecutiveFailures ?? 0),
    pausedUntil: item?.pausedUntil as number | undefined,
    state: breaker.status,
    breaker,
    cursor: (item?.cursor as Record<string, string | number> | undefined) ?? {},
    zeroMatchStreak: Number(item?.zeroMatchStreak ?? 0),
    hasProducedMatches: item?.hasProducedMatches === true,
    lastRun: item?.lastRun as RunSummary | undefined,
  };
}

export async function getSourceStates(sourceIds: readonly string[]): Promise<SourceState[]> {
  if (sourceIds.length === 0) return [];
  const result = await ddb().send(
    new BatchGetCommand({ RequestItems: { [tableName()]: { Keys: sourceIds.map((id) => keys.sourceState(id)) } } }),
  );
  const items = result.Responses?.[tableName()] ?? [];
  return sourceIds.map((id) => toSourceState(id, items.find((i) => i.PK === keys.sourceState(id).PK)));
}

export async function markAttempt(sourceId: string, nowMs: number): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.sourceState(sourceId),
      UpdateExpression: 'SET lastAttemptAt = :now, entity = :e, sourceId = :id',
      ExpressionAttributeValues: { ':now': nowMs, ':e': 'SOURCE_STATE', ':id': sourceId },
    }),
  );
}

export interface SourceStateUpdate {
  breaker: BreakerState;
  validators?: Validators | undefined;
  watermark?: number | undefined;
  success: boolean;
  changed: boolean;
  bootstrappedAt?: string | undefined;
  cursor?: Record<string, string | number> | undefined;
  matched?: number | undefined;
  run: RunSummary;
}

/** §8 step 14: persist validators, watermark, last success and metrics. */
export async function saveSourceState(sourceId: string, update: SourceStateUpdate, nowMs: number): Promise<void> {
  const sets = ['breaker = :breaker', 'lastRun = :run', 'entity = :e', 'sourceId = :id', 'pausedUntil = :paused'];
  const values: Record<string, unknown> = {
    ':breaker': update.breaker,
    ':run': update.run,
    ':e': 'SOURCE_STATE',
    ':id': sourceId,
    ':paused': update.breaker.cooldownUntil ?? null,
  };
  const removes: string[] = [];
  if (update.success) {
    sets.push('lastSuccessAt = :now', 'consecutiveFailures = :zero');
    values[':now'] = nowMs;
    values[':zero'] = 0;
    if (update.changed) sets.push('lastChangeAt = :now');
    // DynamoDB rejects unused expression values, so each branch adds only what it uses.
    if (update.matched !== undefined && update.matched > 0) {
      sets.push('zeroMatchStreak = :zero', 'hasProducedMatches = :true');
      values[':true'] = true;
    } else if (update.matched !== undefined) {
      sets.push('zeroMatchStreak = if_not_exists(zeroMatchStreak, :zero) + :one');
      values[':one'] = 1;
    }
  } else {
    sets.push('consecutiveFailures = if_not_exists(consecutiveFailures, :zero) + :one');
    values[':zero'] = 0;
    values[':one'] = 1;
  }
  if (update.validators) {
    // Only store validators the server supplied (§5.3); drop stale ones otherwise.
    if (update.validators.etag) {
      sets.push('etag = :etag');
      values[':etag'] = update.validators.etag;
    } else removes.push('etag');
    if (update.validators.lastModified) {
      sets.push('lastModified = :lm');
      values[':lm'] = update.validators.lastModified;
    } else removes.push('lastModified');
  }
  if (update.watermark !== undefined) {
    sets.push('watermark = :wm');
    values[':wm'] = update.watermark;
  }
  if (update.bootstrappedAt) {
    sets.push('bootstrappedAt = if_not_exists(bootstrappedAt, :boot)');
    values[':boot'] = update.bootstrappedAt;
  }
  if (update.cursor) {
    sets.push('#cursor = :cursor');
    values[':cursor'] = update.cursor;
  }
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.sourceState(sourceId),
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ExpressionAttributeNames: update.cursor ? { '#cursor': 'cursor' } : undefined,
      ExpressionAttributeValues: values,
    }),
  );
}

/** §7 Source run record (TTL 30 days). */
export async function recordRun(sourceId: string, run: RunSummary, nowMs: number): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        ...keys.sourceRun(sourceId, run.startedAt, run.runId),
        entity: 'SOURCE_RUN',
        sourceId,
        ...run,
        ttl: ttlAfterDays(nowMs, limits.ttlDays.sourceRun),
      },
    }),
  );
}

export async function queryRuns(sourceId: string, sinceIso: string, maxItems = 500): Promise<RunSummary[]> {
  const out: RunSummary[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': keys.sourceState(sourceId).PK, ':from': `RUN#${sinceIso}`, ':to': 'RUN#~' },
        ExclusiveStartKey: startKey,
        Limit: 100,
      }),
    );
    out.push(...((result.Items ?? []) as RunSummary[]));
    startKey = result.LastEvaluatedKey;
  } while (startKey && out.length < maxItems);
  return out;
}

/** Clears a manual-review pause after human review (/resume <source>). */
export async function resetSourceBreaker(sourceId: string, breaker: BreakerState): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.sourceState(sourceId),
      UpdateExpression: 'SET breaker = :b, consecutiveFailures = :zero REMOVE pausedUntil',
      ExpressionAttributeValues: { ':b': breaker, ':zero': 0 },
    }),
  );
}

/** §8 step 1: conditional lease. Returns false if another run holds a valid lease. */
export async function acquireLock(name: string, owner: string, nowMs: number, leaseMs = limits.sync.leaseMs): Promise<boolean> {
  try {
    await ddb().send(
      new PutCommand({
        TableName: tableName(),
        Item: { ...keys.lock(name), entity: 'LOCK', owner, expiresAt: nowMs + leaseMs, ttl: ttlAfterDays(nowMs, 1) },
        ConditionExpression: 'attribute_not_exists(PK) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': nowMs },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/** §8 step 15: release only our own lease. */
export async function releaseLock(name: string, owner: string): Promise<void> {
  try {
    await ddb().send(
      new DeleteCommand({
        TableName: tableName(),
        Key: keys.lock(name),
        ConditionExpression: '#owner = :owner',
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: { ':owner': owner },
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }
}
