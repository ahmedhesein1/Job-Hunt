import { ChangeMessageVisibilityCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { limits } from '../../config/limits';
import type { Settings } from '../data/settings';
import { requiredEnv } from '../lib/secrets';
import { isQuietHours } from '../lib/time';

export type DeliveryDecision = 'INSTANT' | 'DIGEST' | 'NONE';

export interface DeliveryInput {
  score: number;
  confidence: number;
  publishedAt?: string | undefined;
  publishedAtReliable: boolean;
  bootstrapped: boolean;
}

/** §10.4 notification policy (the daily cap is enforced transactionally at insert time). */
export function decideDelivery(input: DeliveryInput, settings: Settings, nowMs: number): DeliveryDecision {
  const n = limits.notifications;
  // First source run: store matches, no alert flood (§8 bootstrap).
  if (!input.bootstrapped) return 'NONE';
  if (input.score < n.digestMinScore || input.confidence < n.minConfidence) return 'NONE';
  if (input.publishedAt && input.publishedAtReliable && nowMs - Date.parse(input.publishedAt) > n.staleAfterPublishMs) {
    // Stale listings are visible in /top, not alerted.
    return 'NONE';
  }
  if (input.score >= n.instantMinScore) {
    if (settings.paused || isQuietHours(nowMs, settings.quietHours)) return 'DIGEST';
    return 'INSTANT';
  }
  return 'DIGEST';
}

const sqs = new SQSClient({});

/**
 * §10.1 step 3: FIFO message with only the notification ID; one message group for the
 * private chat; the notification ID is the deduplication ID.
 */
export async function enqueueNotification(notificationId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: requiredEnv('NOTIFICATION_QUEUE_URL'),
      MessageBody: JSON.stringify({ notificationId }),
      MessageGroupId: requiredEnv('TELEGRAM_CHAT_ID'),
      MessageDeduplicationId: notificationId,
    }),
  );
}

/** §10.1 steps 6/8: delay redelivery instead of sleeping in Lambda. */
export async function delayMessage(receiptHandle: string, delayMs: number): Promise<void> {
  const seconds = Math.min(43_200, Math.max(1, Math.ceil(delayMs / 1000)));
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: requiredEnv('NOTIFICATION_QUEUE_URL'),
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: seconds,
    }),
  );
}

export function sqsClient(): SQSClient {
  return sqs;
}
