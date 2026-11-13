import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { markQueued } from '../data/outbox';
import { logger } from '../lib/logger';
import { enqueueNotification } from '../notifications/queue';
import { withUsage } from '../lib/usage';

/**
 * §10.1 steps 2–4: DynamoDB Streams (INSERT of NOTIF items only, filtered in the event
 * source mapping) → SQS FIFO → PENDING→QUEUED. Duplicate dispatches are safe: FIFO
 * deduplicates by notification ID and the sender re-checks status before sending.
 */
async function handle(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const batchItemFailures: DynamoDBBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) continue;
      const image = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>);
      if (image.entity !== 'NOTIF' || image.status !== 'PENDING') continue;
      const notificationId = String(image.PK).replace(/^NOTIF#/, '');
      await enqueueNotification(notificationId);
      // If this conditional update fails after SQS accepted the message, the sender
      // still accepts a PENDING item (§10.1 step 4).
      await markQueued(notificationId, Date.now());
    } catch (err) {
      logger.error('dispatch failed', { error: err, sequenceNumber: record.dynamodb?.SequenceNumber });
      if (record.dynamodb?.SequenceNumber) {
        batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
        // Stream batches must be retried in order: stop at the first failure.
        break;
      }
    }
  }
  return { batchItemFailures };
}

/** §9: usage counters (HTTP, Telegram) are flushed once per invocation. */
export const handler = withUsage(handle);
