import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { logger } from '../lib/logger';
import { deliverNotification } from '../notifications/sender';
import { withUsage } from '../lib/usage';

/**
 * §10.1 step 5: FIFO consumer with batch size 1 and reserved concurrency 1, reporting
 * partial batch failures. Retries flow through SQS visibility/redrive, never a sleep.
 */
async function handle(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body) as { notificationId?: unknown };
      if (typeof body.notificationId !== 'string' || !/^[0-9a-f]{24}$/.test(body.notificationId)) {
        logger.error('invalid queue message; dropping', { messageId: record.messageId });
        continue;
      }
      const outcome = await deliverNotification(body.notificationId, record.receiptHandle);
      logger.info('notification processed', { notificationId: body.notificationId, outcome: outcome.kind, detail: outcome.detail });
      if (outcome.kind === 'retry') batchItemFailures.push({ itemIdentifier: record.messageId });
    } catch (err) {
      logger.error('notification send failed', { messageId: record.messageId, error: err });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

/** §9: usage counters (HTTP, Telegram) are flushed once per invocation. */
export const handler = withUsage(handle);
