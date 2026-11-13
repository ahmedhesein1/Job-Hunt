import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { limits } from '../../config/limits';
import { stableId } from '../core/url';
import { ttlAfterDays } from '../lib/time';
import { ddb, tableName } from './client';

/**
 * `/missed <url>` reports (§11), kept in the source partition next to its runs so the
 * weekly report can show which sources miss jobs. The URL is stored, never fetched.
 */
export async function recordMissedReport(sourceId: string, canonicalUrl: string, alreadyKnown: boolean, nowMs: number): Promise<void> {
  const at = new Date(nowMs).toISOString();
  await ddb().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        PK: `SOURCE#${sourceId}`,
        SK: `MISSED#${at}#${stableId(canonicalUrl)}`,
        entity: 'MISSED_REPORT',
        url: canonicalUrl,
        alreadyKnown,
        createdAt: at,
        ttl: ttlAfterDays(nowMs, limits.ttlDays.sourceRun),
      },
    }),
  );
}
