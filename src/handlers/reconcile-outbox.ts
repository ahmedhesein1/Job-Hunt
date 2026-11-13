import { limits } from '../../config/limits';
import { markQueued, queryPending } from '../data/outbox';
import { logger } from '../lib/logger';
import { iso } from '../lib/time';
import { enqueueNotification } from '../notifications/queue';
import { withUsage } from '../lib/usage';

/**
 * §10.2: every five minutes, re-enqueue PENDING outbox records the stream dispatcher
 * missed. Idempotent: FIFO deduplication + sender status checks prevent double sends.
 */
async function handle(): Promise<{ inspected: number; enqueued: number }> {
  const nowMs = Date.now();
  const pending = await queryPending(iso(nowMs - limits.notifications.reconcileMinAgeMs), limits.notifications.reconcileMaxItems);
  let enqueued = 0;
  for (const { notificationId } of pending) {
    try {
      await enqueueNotification(notificationId);
      await markQueued(notificationId, Date.now());
      enqueued += 1;
    } catch (err) {
      logger.error('reconcile enqueue failed', { notificationId, error: err });
    }
  }
  if (pending.length > 0) logger.info('outbox reconciled', { inspected: pending.length, enqueued });
  return { inspected: pending.length, enqueued };
}

/** §9: usage counters (HTTP, Telegram) are flushed once per invocation. */
export const handler = withUsage(handle);
