import { telegramBotToken } from '../lib/secrets';
import { countUsage } from '../lib/usage';

/**
 * Minimal Telegram Bot API client (verified against Bot API 10.4, 2026-11-09).
 * Errors carry `error_code`, `description` and `parameters.retry_after` (seconds).
 */
export class TelegramError extends Error {
  override name = 'TelegramError';
  constructor(
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfterSec: number | undefined,
  ) {
    super(`Telegram ${errorCode}: ${description}`);
  }

  get isRateLimit(): boolean {
    return this.errorCode === 429;
  }

  /** 400 (bad message) and 403 (bot blocked/kicked) are not retried (§10.1 step 9). */
  get isPermanent(): boolean {
    return this.errorCode === 400 || this.errorCode === 403 || this.errorCode === 404;
  }
}

export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

const API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** Test hook. */
export function setTelegramFetch(f: FetchLike): void {
  fetchImpl = f;
}

async function call<T>(method: string, init: { json?: unknown; form?: FormData }): Promise<T> {
  try {
    const result = await callOnce<T>(method, init);
    countUsage('telegramRequests');
    if (method === 'sendMessage' || method === 'sendDocument') countUsage('telegramSent');
    return result;
  } catch (err) {
    // §9 usage: every failed Bot API call, with 429s counted separately.
    countUsage('telegramRequests');
    countUsage('telegramFailed');
    if (err instanceof TelegramError && err.isRateLimit) countUsage('telegramRateLimited');
    throw err;
  }
}

async function callOnce<T>(method: string, init: { json?: unknown; form?: FormData }): Promise<T> {
  const token = await telegramBotToken();
  let response: Response;
  try {
    response = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: init.json !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Network/timeout: temporary; the token never appears in the message.
    throw new TelegramError(0, `network error (${(err as Error).name})`, undefined);
  }
  let body: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new TelegramError(response.status, 'invalid JSON response', undefined);
  }
  if (!body.ok) {
    throw new TelegramError(body.error_code ?? response.status, body.description ?? 'unknown error', body.parameters?.retry_after);
  }
  return body.result as T;
}

export function callTelegram<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return call<T>(method, { json: params });
}

export async function sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboard): Promise<number> {
  const result = await callTelegram<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return result.message_id;
}

export async function editReplyMarkup(chatId: string, messageId: number, replyMarkup: InlineKeyboard): Promise<void> {
  try {
    await callTelegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  } catch (err) {
    // "message is not modified" is harmless.
    if (!(err instanceof TelegramError && /not modified/i.test(err.description))) throw err;
  }
}

export async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  await callTelegram('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

/**
 * Downloads a file the owner sent to the bot (getFile + file endpoint). The size cap is
 * enforced on the declared size and again while streaming. Errors never include the
 * download URL, which contains the bot token.
 */
export async function downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array> {
  const file = await callTelegram<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
  if (!file.file_path) throw new TelegramError(400, 'file is not available for download', undefined);
  if (file.file_size !== undefined && file.file_size > maxBytes) throw new TelegramError(413, `file larger than ${maxBytes} bytes`, undefined);
  const token = await telegramBotToken();
  let response: Response;
  try {
    response = await fetchImpl(`${API}/file/bot${token}/${file.file_path}`, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new TelegramError(0, `network error (${(err as Error).name})`, undefined);
  }
  if (!response.ok || !response.body) throw new TelegramError(response.status, 'file download failed', undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    // Leaving the for-await loop cancels the stream.
    if (total > maxBytes) throw new TelegramError(413, `file larger than ${maxBytes} bytes`, undefined);
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Multipart document upload (≤50 MB) for the weekly backup (§13). */
export async function sendDocument(chatId: string, filename: string, content: Uint8Array, caption: string): Promise<number> {
  const form = new FormData();
  form.set('chat_id', chatId);
  form.set('caption', caption.slice(0, 1024));
  form.set('document', new Blob([Uint8Array.from(content)], { type: 'application/gzip' }), filename);
  const result = await call<{ message_id: number }>('sendDocument', { form });
  return result.message_id;
}
