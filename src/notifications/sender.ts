import { getJob, setJobNotified } from '../data/jobs';
import { getNotification, markFailed, markSent, recordAttempt } from '../data/outbox';
import { getSettings } from '../data/settings';
import { deferSendSlot, recordSuccessfulSend, reserveSendSlot } from '../data/telegram-updates';
import { logger } from '../lib/logger';
import { telegramChatId } from '../lib/secrets';
import { sendMessage, TelegramError, type InlineKeyboard } from '../telegram/bot';
import { alertKeyboard } from '../telegram/keyboards';
import { formatJobAlert } from './formatting';
import { delayMessage } from './queue';

export type SendOutcome =
  | { kind: 'done'; detail: string }
  | { kind: 'retry'; delayMs?: number | undefined; detail: string };

/**
 * §10.1 steps 5–9 for one notification. The caller (single-concurrency SQS consumer)
 * acknowledges on `done` and reports a batch item failure on `retry`.
 */
export async function deliverNotification(notificationId: string, receiptHandle: string, now: () => number = Date.now): Promise<SendOutcome> {
  const notification = await getNotification(notificationId);
  if (!notification) return { kind: 'done', detail: 'missing outbox item' };
  // Duplicate SQS deliveries after SENT/FAILED are acknowledged without sending.
  if (notification.status === 'SENT' || notification.status === 'FAILED') return { kind: 'done', detail: `already ${notification.status}` };

  let text: string;
  let markup: InlineKeyboard | undefined;
  let jobId: string | undefined;
  if (notification.kind === 'JOB') {
    jobId = notification.jobId;
    const job = jobId ? await getJob(jobId) : undefined;
    if (!job) {
      await markFailed(notificationId, 'job unavailable');
      return { kind: 'done', detail: 'job unavailable' };
    }
    const settings = await getSettings();
    if (settings.mutedCompanies.has(job.companyKey) || job.userStatus !== 'New') {
      await markFailed(notificationId, job.userStatus !== 'New' ? `skipped: already ${job.userStatus}` : 'skipped: company muted');
      return { kind: 'done', detail: 'skipped' };
    }
    text = formatJobAlert(job, now());
    markup = alertKeyboard(job.jobId, job.applyUrl);
  } else {
    text = notification.text ?? '';
    markup = notification.replyMarkup ? (JSON.parse(notification.replyMarkup) as InlineKeyboard) : undefined;
    if (!text) {
      await markFailed(notificationId, 'empty text');
      return { kind: 'done', detail: 'empty text' };
    }
  }

  const chatId = telegramChatId();
  // §10.1 step 6: reserve the chat's send slot; if not ready, delay via SQS visibility.
  const slot = await reserveSendSlot(chatId, now());
  if (!slot.ok) {
    await delayMessage(receiptHandle, slot.waitMs);
    return { kind: 'retry', delayMs: slot.waitMs, detail: 'rate slot busy' };
  }

  try {
    const messageId = await sendMessage(chatId, text, markup);
    const sentAt = now();
    // A crash between send and this update can cause one duplicate (§10.3, at-least-once).
    await markSent(notificationId, messageId, sentAt);
    await recordSuccessfulSend(chatId, sentAt);
    if (jobId) await setJobNotified(jobId, messageId, sentAt);
    return { kind: 'done', detail: 'sent' };
  } catch (err) {
    if (!(err instanceof TelegramError)) throw err;
    if (err.isRateLimit) {
      const delayMs = Math.max(1, err.retryAfterSec ?? 5) * 1000;
      await deferSendSlot(chatId, now() + delayMs);
      await recordAttempt(notificationId, err.message);
      await delayMessage(receiptHandle, delayMs);
      logger.warn('telegram rate limited', { notificationId, retryAfterSec: err.retryAfterSec });
      return { kind: 'retry', delayMs, detail: 'telegram 429' };
    }
    if (err.isPermanent) {
      await markFailed(notificationId, err.message);
      logger.error('telegram permanent failure', { notificationId, code: err.errorCode, description: err.description });
      return { kind: 'done', detail: 'permanent failure' };
    }
    await recordAttempt(notificationId, err.message);
    logger.warn('telegram temporary failure', { notificationId, code: err.errorCode });
    return { kind: 'retry', detail: 'temporary failure' };
  }
}
