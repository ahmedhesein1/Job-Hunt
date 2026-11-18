import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { limits } from '../../config/limits';
import { ddb, tableName } from './client';
import { keys } from './keys';

/** `SETTINGS` / `GLOBAL` (§7). */
export interface Settings {
  paused: boolean;
  instantSentToday: number;
  day: string | undefined;
  quietHours: { startHour: number; endHour: number };
  maxInstantAlertsPerDay: number;
  mutedCompanies: Set<string>;
  activeBoards: number;
  /**
   * Private chats (Telegram user IDs) that also receive the job alerts and digests, set by
   * the owner with /friends. They get no commands, buttons or system messages.
   */
  shareChatIds: Set<string>;
}

export function defaultSettings(): Settings {
  return {
    paused: false,
    instantSentToday: 0,
    day: undefined,
    quietHours: { ...limits.notifications.quietHours },
    maxInstantAlertsPerDay: limits.notifications.defaultInstantDailyCap,
    mutedCompanies: new Set(),
    activeBoards: 0,
    shareChatIds: new Set(),
  };
}

export async function getSettings(): Promise<Settings> {
  const result = await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.settings(), ConsistentRead: true }));
  const item = result.Item;
  const d = defaultSettings();
  if (!item) return d;
  const quiet = item.quietHours as { startHour?: number; endHour?: number } | undefined;
  return {
    paused: item.paused === true,
    instantSentToday: Number(item.instantSentToday ?? 0),
    day: item.day as string | undefined,
    quietHours: { startHour: quiet?.startHour ?? d.quietHours.startHour, endHour: quiet?.endHour ?? d.quietHours.endHour },
    maxInstantAlertsPerDay: Number(item.maxInstantAlertsPerDay ?? d.maxInstantAlertsPerDay),
    mutedCompanies: item.mutedCompanies instanceof Set ? new Set([...item.mutedCompanies].map(String)) : new Set(),
    activeBoards: Number(item.activeBoards ?? 0),
    shareChatIds: item.shareChatIds instanceof Set ? new Set([...item.shareChatIds].map(String)) : new Set(),
  };
}

export async function setPaused(paused: boolean): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.settings(),
      UpdateExpression: 'SET paused = :p, entity = :e',
      ExpressionAttributeValues: { ':p': paused, ':e': 'SETTINGS' },
    }),
  );
}

/**
 * Transaction item that reserves one instant alert under the daily cap (§10.4).
 * Two variants keep the plan's `instantSentToday` + `day` fields on one item: same day →
 * increment under the cap; new day → reset to 1. A failed condition means "cap reached
 * or raced" and the caller falls back to the digest.
 */
export function instantCapUpdate(today: string, current: Settings) {
  if (current.day === today) {
    return {
      Update: {
        TableName: tableName(),
        Key: keys.settings(),
        UpdateExpression: 'ADD instantSentToday :one',
        ConditionExpression: '#day = :today AND instantSentToday < :cap',
        ExpressionAttributeNames: { '#day': 'day' },
        ExpressionAttributeValues: { ':one': 1, ':today': today, ':cap': current.maxInstantAlertsPerDay },
      },
    };
  }
  return {
    Update: {
      TableName: tableName(),
      Key: keys.settings(),
      UpdateExpression: 'SET #day = :today, instantSentToday = :one, entity = :e',
      ConditionExpression: 'attribute_not_exists(#day) OR #day <> :today',
      ExpressionAttributeNames: { '#day': 'day' },
      ExpressionAttributeValues: { ':one': 1, ':today': today, ':e': 'SETTINGS' },
    },
  };
}

/** Telegram user IDs: positive integers (private chats), at most 15 digits. */
export const TELEGRAM_USER_ID = /^[1-9]\d{0,14}$/;

/** Adds or removes a chat that receives shared job alerts and digests (/friends). */
export async function setShareChat(chatId: string, shared: boolean): Promise<void> {
  if (!TELEGRAM_USER_ID.test(chatId)) throw new Error(`invalid Telegram user ID: ${chatId}`);
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.settings(),
      UpdateExpression: `${shared ? 'ADD' : 'DELETE'} shareChatIds :c SET entity = :e`,
      ExpressionAttributeValues: { ':c': new Set([chatId]), ':e': 'SETTINGS' },
    }),
  );
}

/** Mute a company: COMPANY item + the muted set on settings, atomically. */
export async function setCompanyMuted(companyKey: string, name: string, muted: boolean): Promise<void> {
  await ddb().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName(),
            Key: keys.company(companyKey),
            UpdateExpression: 'SET #name = :name, muted = :muted, entity = :e',
            ExpressionAttributeNames: { '#name': 'name' },
            ExpressionAttributeValues: { ':name': name, ':muted': muted, ':e': 'COMPANY' },
          },
        },
        {
          Update: {
            TableName: tableName(),
            Key: keys.settings(),
            UpdateExpression: `${muted ? 'ADD' : 'DELETE'} mutedCompanies :k SET entity = :e`,
            ExpressionAttributeValues: { ':k': new Set([companyKey]), ':e': 'SETTINGS' },
          },
        },
      ],
    }),
  );
}
