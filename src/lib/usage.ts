import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableName } from '../data/client';
import { keys } from '../data/keys';
import { logger } from './logger';
import { ttlAfterDays } from './time';

/**
 * In-app usage counters (§9: outgoing HTTP requests, downloaded bytes, Telegram calls).
 * Counted in memory during one Lambda invocation and written once at the end with a
 * single atomic ADD, so measuring adds one DynamoDB write per invocation, not per request.
 */
export type UsageCounter =
  | 'httpRequests'
  | 'httpBytes'
  | 'httpErrors'
  | 'browserPages'
  | 'telegramRequests'
  | 'telegramSent'
  | 'telegramFailed'
  | 'telegramRateLimited';

const totals = new Map<UsageCounter, number>();
const hosts = new Map<string, { requests: number; bytes: number }>();

export function countUsage(counter: UsageCounter, n = 1): void {
  if (!Number.isFinite(n) || n <= 0) return;
  totals.set(counter, (totals.get(counter) ?? 0) + n);
}

/** One outgoing HTTP request (per redirect hop) and the bytes read from it. */
export function countHttp(host: string, bytes = 0): void {
  countUsage('httpRequests');
  countUsage('httpBytes', bytes);
  const h = hosts.get(host) ?? { requests: 0, bytes: 0 };
  h.requests += 1;
  h.bytes += Math.max(0, bytes);
  hosts.set(host, h);
}

/** Bytes read after the request was counted (streamed bodies). */
export function countHttpBytes(host: string, bytes: number): void {
  if (bytes <= 0) return;
  countUsage('httpBytes', bytes);
  const h = hosts.get(host) ?? { requests: 0, bytes: 0 };
  h.bytes += bytes;
  hosts.set(host, h);
}

export function usageSnapshot(): { totals: Record<string, number>; hosts: Record<string, { requests: number; bytes: number }> } {
  return { totals: Object.fromEntries(totals), hosts: Object.fromEntries([...hosts].map(([k, v]) => [k, { ...v }])) };
}

export function resetUsage(): void {
  totals.clear();
  hosts.clear();
}

/** Builds the single UpdateItem that adds this invocation's counters to the day item. */
export function usageUpdate(day: string, nowMs: number): ConstructorParameters<typeof UpdateCommand>[0] | undefined {
  if (totals.size === 0 && hosts.size === 0) return undefined;
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':ttl': ttlAfterDays(nowMs, 400), ':e': 'APP_USAGE' };
  const adds: string[] = [];
  let i = 0;
  for (const [counter, n] of totals) {
    names[`#c${i}`] = counter;
    values[`:c${i}`] = n;
    adds.push(`#c${i} :c${i}`);
    i += 1;
  }
  for (const [host, h] of hosts) {
    names[`#r${i}`] = `req#${host}`;
    values[`:r${i}`] = h.requests;
    names[`#b${i}`] = `bytes#${host}`;
    values[`:b${i}`] = h.bytes;
    adds.push(`#r${i} :r${i}`, `#b${i} :b${i}`);
    i += 1;
  }
  return {
    TableName: tableName(),
    Key: keys.appUsage(day),
    UpdateExpression: `SET entity = :e, #ttl = :ttl ADD ${adds.join(', ')}`,
    ExpressionAttributeNames: { ...names, '#ttl': 'ttl' },
    ExpressionAttributeValues: values,
  };
}

/** Writes and clears the counters. Never throws: measuring must not fail the work. */
export async function flushUsage(nowMs = Date.now()): Promise<void> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const update = usageUpdate(day, nowMs);
  resetUsage();
  if (!update) return;
  try {
    await ddb().send(new UpdateCommand(update));
  } catch (err) {
    logger.warn('usage flush failed', { error: err });
  }
}

/** Wraps a Lambda handler so its counters are flushed when it returns or throws. */
export function withUsage<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } finally {
      await flushUsage();
    }
  };
}
