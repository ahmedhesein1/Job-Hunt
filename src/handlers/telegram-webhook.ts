import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { timingSafeEqual } from 'node:crypto';
import { claimUpdate, reserveSendSlot } from '../data/telegram-updates';
import { logger } from '../lib/logger';
import { getSecretFromEnv, telegramChatId } from '../lib/secrets';
import { sleep } from '../lib/time';
import { answerCallback, editReplyMarkup, sendMessage, TelegramError, type InlineKeyboard } from '../telegram/bot';
import { handleCallback, handleCommand } from '../telegram/commands';
import { handleSnapshotDocument, type TelegramDocument } from '../telegram/linkedin';
import { parseCallbackData } from '../telegram/keyboards';
import { withUsage } from '../lib/usage';

/**
 * §11 webhook: Lambda Function URL + Telegram `secret_token` header, private chat ID
 * only, update_id idempotency before side effects, and no source HTTP requests here
 * (files the owner uploads are downloaded from Telegram, never from the source).
 */
interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    /** Unix seconds. */
    date?: number;
    text?: string;
    document?: TelegramDocument;
    chat: { id: number; type: string };
    from?: { id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number; type: string } };
  };
}

type WebhookResult = Extract<LambdaFunctionURLResult, { statusCode?: number }> & { statusCode: number };
const OK: WebhookResult = { statusCode: 200, body: '' };

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Replies share the chat's send-slot reservation with the notification sender. */
async function reply(chatId: string, text: string, markup?: InlineKeyboard): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const slot = await reserveSendSlot(chatId, Date.now());
    if (slot.ok) {
      await sendMessage(chatId, text, markup);
      return;
    }
    // Wait at most a couple of seconds; a user-initiated reply must stay responsive.
    await sleep(Math.min(slot.waitMs, 2_000) + 20);
  }
  logger.warn('reply skipped: send slot unavailable');
}

async function handle(event: LambdaFunctionURLEvent): Promise<WebhookResult> {
  if (event.requestContext?.http?.method !== 'POST') return { statusCode: 405, body: '' };
  const expected = await getSecretFromEnv('TELEGRAM_WEBHOOK_SECRET_PARAM');
  const provided = event.headers?.['x-telegram-bot-api-secret-token'] ?? '';
  if (!safeEqual(provided, expected)) {
    logger.warn('webhook rejected: invalid secret');
    return { statusCode: 401, body: '' };
  }

  let update: TelegramUpdate;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    update = JSON.parse(raw) as TelegramUpdate;
  } catch {
    return { statusCode: 400, body: '' };
  }
  if (typeof update.update_id !== 'number') return OK;

  const chatId = telegramChatId();
  const fromChat = update.message?.chat ?? update.callback_query?.message?.chat;
  const fromUser = update.message?.from?.id ?? update.callback_query?.from.id;
  // Only the configured private chat; others are ignored without revealing anything.
  if (!fromChat || String(fromChat.id) !== chatId || fromChat.type !== 'private' || String(fromUser) !== chatId) {
    logger.warn('webhook ignored: unexpected chat');
    return OK;
  }

  if (!(await claimUpdate(update.update_id, Date.now()))) return OK;

  try {
    if (update.message?.text?.startsWith('/')) {
      const response = await handleCommand(update.message.text);
      await reply(chatId, response.text, response.markup);
    } else if (update.message?.document) {
      // A LinkedIn results page the owner saved in their own browser (never fetched here).
      const nowMs = Date.now();
      const sentAtMs = update.message.date ? Math.min(update.message.date * 1000, nowMs) : nowMs;
      await reply(chatId, await handleSnapshotDocument(update.message.document, sentAtMs, nowMs));
    } else if (update.callback_query) {
      const cb = update.callback_query;
      const parsed = parseCallbackData(cb.data);
      if (!parsed) {
        await answerCallback(cb.id, 'Unsupported action');
        return OK;
      }
      const result = await handleCallback(parsed);
      await answerCallback(cb.id, result.toast);
      if (result.markup && cb.message) await editReplyMarkup(chatId, cb.message.message_id, result.markup);
    }
  } catch (err) {
    // The update is already claimed: report the failure instead of letting Telegram retry.
    logger.error('webhook handling failed', { error: err, updateId: update.update_id });
    if (!(err instanceof TelegramError)) {
      await reply(chatId, '⚠️ Something went wrong handling that request. Check CloudWatch logs.').catch(() => undefined);
    }
  }
  return OK;
}

/** §9: usage counters (HTTP, Telegram) are flushed once per invocation. */
export const handler = withUsage(handle);
