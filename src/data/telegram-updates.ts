import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { limits } from '../../config/limits';
import { ttlAfterDays } from '../lib/time';
import { ddb, isConditionalCheckFailed, tableName } from './client';
import { keys } from './keys';

/**
 * §11 webhook idempotency: claim each update_id with a conditional put *before* side
 * effects. Returns false when the update was already processed.
 */
export async function claimUpdate(updateId: number, nowMs: number): Promise<boolean> {
  try {
    await ddb().send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          ...keys.telegramUpdate(updateId),
          entity: 'TELEGRAM_UPDATE',
          processedAt: new Date(nowMs).toISOString(),
          ttl: ttlAfterDays(nowMs, limits.ttlDays.telegramUpdate),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

export type SlotResult = { ok: true } | { ok: false; waitMs: number };

/**
 * §10.1 step 6: atomically reserve a send slot in `TELEGRAM#<chatId>` / `RATE`:
 * require nextAllowedAt <= now, then set nextAllowedAt = now + gap. Safe across
 * separate execution environments; no in-memory state.
 */
export async function reserveSendSlot(chatId: string, nowMs: number, gapMs = limits.notifications.telegramGapMs): Promise<SlotResult> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: keys.telegramRate(chatId),
        UpdateExpression: 'SET nextAllowedAt = :next, entity = :e',
        ConditionExpression: 'attribute_not_exists(nextAllowedAt) OR nextAllowedAt <= :now',
        ExpressionAttributeValues: { ':next': nowMs + gapMs, ':now': nowMs, ':e': 'TELEGRAM_RATE' },
      }),
    );
    return { ok: true };
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
    const current = await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.telegramRate(chatId), ConsistentRead: true }));
    const next = Number(current.Item?.nextAllowedAt ?? nowMs);
    return { ok: false, waitMs: Math.max(1, next - nowMs) };
  }
}

/** Telegram 429: push the next allowed time to at least now + retry_after (§10.1 step 8). */
export async function deferSendSlot(chatId: string, untilMs: number): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.telegramRate(chatId),
      UpdateExpression: 'SET nextAllowedAt = :until, lastRateLimitedAt = :now, entity = :e',
      ConditionExpression: 'attribute_not_exists(nextAllowedAt) OR nextAllowedAt < :until',
      ExpressionAttributeValues: { ':until': untilMs, ':now': Date.now(), ':e': 'TELEGRAM_RATE' },
    }),
  ).catch((err: unknown) => {
    if (!isConditionalCheckFailed(err)) throw err;
  });
}

export async function recordSuccessfulSend(chatId: string, nowMs: number): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.telegramRate(chatId),
      UpdateExpression: 'SET lastSuccessfulTelegramSendAt = :now',
      ExpressionAttributeValues: { ':now': new Date(nowMs).toISOString() },
    }),
  );
}

export async function getRateState(chatId: string): Promise<Record<string, unknown> | undefined> {
  const result = await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.telegramRate(chatId) }));
  return result.Item;
}
