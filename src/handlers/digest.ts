import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { limits } from '../../config/limits';
import { ddb, tableName } from '../data/client';
import { batchGetJobs, digestSentUpdate, queryDigest, type JobItem } from '../data/jobs';
import { keys } from '../data/keys';
import { outboxPut, textNotificationId } from '../data/outbox';
import { getSettings } from '../data/settings';
import { logger } from '../lib/logger';
import { escapeHtml, formatJobLine } from '../notifications/formatting';
import { withUsage } from '../lib/usage';

/**
 * §10.5: read GSI2 `DIGEST`, best score first, up to 20 jobs in compact messages. Each
 * message is an outbox item, so digests share the serialized, rate-limited sender.
 * Jobs are marked sent and leave the queue in the same transaction as their message.
 */
export async function runDigest(nowMs: number): Promise<{ jobs: number; messages: number }> {
  const ids = await queryDigest(limits.notifications.digestMaxJobs * 2);
  if (ids.length === 0) return { jobs: 0, messages: 0 };
  const settings = await getSettings();
  const all = await batchGetJobs(ids);
  const stale = all.filter((j) => j.userStatus !== 'New' || settings.mutedCompanies.has(j.companyKey));
  const ready = all
    .filter((j) => !stale.includes(j))
    .sort((a, b) => b.score - a.score || a.discoveredAt.localeCompare(b.discoveredAt))
    .slice(0, limits.notifications.digestMaxJobs);

  // Jobs acted on or muted since they were queued simply leave the digest.
  for (const job of stale) {
    await ddb()
      .send(new TransactWriteCommand({ TransactItems: [digestSentUpdate(job.jobId, nowMs)] }))
      .catch((err: unknown) => logger.warn('digest cleanup failed', { jobId: job.jobId, error: err }));
  }

  const perMessage = limits.notifications.digestJobsPerMessage;
  const chunks: JobItem[][] = [];
  for (let i = 0; i < ready.length; i += perMessage) chunks.push(ready.slice(i, i + perMessage));
  let messages = 0;
  for (const [index, chunk] of chunks.entries()) {
    const header = `📬 <b>Digest</b>${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''} — ${ready.length} job${ready.length === 1 ? '' : 's'}`;
    const lines = chunk.map((job, i) => formatJobLine(job, index * perMessage + i + 1));
    const text = [header, '', ...lines, '', `<i>${escapeHtml('Use /top to act on these jobs.')}</i>`].join('\n');
    const notificationId = textNotificationId(`digest:${chunk.map((j) => j.jobId).join(',')}`);
    try {
      await ddb().send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: outboxPut({ notificationId, kind: 'TEXT', text }, nowMs) },
            ...chunk.map((job) => digestSentUpdate(job.jobId, nowMs)),
          ] as never,
        }),
      );
      messages += 1;
    } catch (err) {
      // A concurrent digest already took some of these jobs; they will not be lost.
      logger.warn('digest chunk skipped', { error: err, jobs: chunk.length });
    }
  }
  return { jobs: ready.length, messages };
}

async function handle(): Promise<{ jobs: number; messages: number }> {
  const result = await runDigest(Date.now());
  logger.info('digest queued', result);
  return result;
}

export const __test = { keys, tableName };

/** §9: usage counters (HTTP, Telegram) are flushed once per invocation. */
export const handler = withUsage(handle);
