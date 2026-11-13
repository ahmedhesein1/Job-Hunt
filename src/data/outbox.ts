import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { limits } from '../../config/limits';
import { stableId } from '../core/url';
import { ttlAfterDays } from '../lib/time';
import { ddb, isConditionalCheckFailed, tableName } from './client';
import { gsi2, keys } from './keys';

/** §7 `NOTIF#<id>` outbox record and its §10.1 status machine. */
export type OutboxStatus = 'PENDING' | 'QUEUED' | 'SENT' | 'FAILED';
export type OutboxKind = 'JOB' | 'TEXT';

export interface OutboxItem {
  notificationId: string;
  kind: OutboxKind;
  status: OutboxStatus;
  createdAt: string;
  jobId?: string | undefined;
  clusterId?: string | undefined;
  score?: number | undefined;
  /** Pre-rendered HTML for TEXT notifications (summaries, warnings, digests). */
  text?: string | undefined;
  /** JSON-encoded inline keyboard for TEXT notifications. */
  replyMarkup?: string | undefined;
  queuedAt?: string | undefined;
  sentAt?: string | undefined;
  telegramMessageId?: number | undefined;
  attempts?: number | undefined;
  failureReason?: string | undefined;
}

export const jobNotificationId = (jobId: string) => stableId('notif-job', jobId);
export const textNotificationId = (dedupeKey: string) => stableId('notif-text', dedupeKey);

/** Transaction/put item for a new PENDING outbox record (idempotent on its ID). */
export function outboxPut(item: Omit<OutboxItem, 'status' | 'createdAt'>, nowMs: number) {
  const createdAt = new Date(nowMs).toISOString();
  return {
    TableName: tableName(),
    Item: {
      ...keys.notification(item.notificationId),
      ...gsi2.outboxPending(createdAt),
      entity: 'NOTIF',
      ...item,
      status: 'PENDING' satisfies OutboxStatus,
      createdAt,
      attempts: 0,
      ttl: ttlAfterDays(nowMs, limits.ttlDays.notification),
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  };
}

/** Enqueue a TEXT notification. Returns false if one with the same dedupe key exists. */
export async function putTextNotification(dedupeKey: string, text: string, nowMs: number, replyMarkup?: unknown): Promise<boolean> {
  try {
    await ddb().send(
      new PutCommand(
        outboxPut(
          {
            notificationId: textNotificationId(dedupeKey),
            kind: 'TEXT',
            text,
            replyMarkup: replyMarkup ? JSON.stringify(replyMarkup) : undefined,
          },
          nowMs,
        ),
      ),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

export async function getNotification(notificationId: string): Promise<OutboxItem | undefined> {
  const result = await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.notification(notificationId), ConsistentRead: true }));
  return result.Item as OutboxItem | undefined;
}

async function transition(
  notificationId: string,
  allowedFrom: OutboxStatus[],
  set: Record<string, unknown>,
  removeQueueIndex: boolean,
): Promise<boolean> {
  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  for (const [k, v] of Object.entries(set)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  const fromPlaceholders = allowedFrom.map((s, i) => {
    values[`:from${i}`] = s;
    return `:from${i}`;
  });
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: keys.notification(notificationId),
        UpdateExpression: `SET ${sets.join(', ')}${removeQueueIndex ? ' REMOVE GSI2PK, GSI2SK' : ''}`,
        ConditionExpression: `#status IN (${fromPlaceholders.join(', ')})`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/** PENDING → QUEUED; leaves the OUTBOX#PENDING queue index (§7.1). */
export function markQueued(notificationId: string, nowMs: number): Promise<boolean> {
  return transition(notificationId, ['PENDING'], { status: 'QUEUED', queuedAt: new Date(nowMs).toISOString() }, true);
}

export function markSent(notificationId: string, telegramMessageId: number, nowMs: number): Promise<boolean> {
  return transition(
    notificationId,
    ['PENDING', 'QUEUED'],
    { status: 'SENT', sentAt: new Date(nowMs).toISOString(), telegramMessageId },
    true,
  );
}

export function markFailed(notificationId: string, reason: string): Promise<boolean> {
  return transition(notificationId, ['PENDING', 'QUEUED'], { status: 'FAILED', failureReason: reason.slice(0, 500) }, true);
}

export async function recordAttempt(notificationId: string, error: string): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.notification(notificationId),
      UpdateExpression: 'ADD attempts :one SET lastError = :err',
      ExpressionAttributeValues: { ':one': 1, ':err': error.slice(0, 500) },
    }),
  );
}

/** Pending outbox records created before `beforeIso` (oldest first), for the reconciler. */
export async function queryPending(beforeIso: string, limit: number): Promise<Array<{ notificationId: string; createdAt: string }>> {
  const result = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: gsi2.name,
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK < :before',
      ExpressionAttributeValues: { ':pk': gsi2.OUTBOX_PENDING, ':before': beforeIso },
      Limit: limit,
    }),
  );
  return (result.Items ?? []).map((i) => ({ notificationId: String(i.PK).replace(/^NOTIF#/, ''), createdAt: String(i.GSI2SK) }));
}

/** Pending count and oldest age, bounded (health check / status). */
export async function pendingSummary(maxItems = 200): Promise<{ count: number; oldestCreatedAt?: string | undefined; truncated: boolean }> {
  const result = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: gsi2.name,
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': gsi2.OUTBOX_PENDING },
      Limit: maxItems,
    }),
  );
  const items = result.Items ?? [];
  return { count: items.length, oldestCreatedAt: items[0]?.GSI2SK as string | undefined, truncated: Boolean(result.LastEvaluatedKey) };
}
