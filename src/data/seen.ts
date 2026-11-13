import { BatchGetCommand, BatchWriteCommand, type BatchGetCommandOutput, type BatchWriteCommandOutput } from '@aws-sdk/lib-dynamodb';
import { sha256Hex } from '../core/url';
import { sleep, ttlAfterDays } from '../lib/time';
import { ddb, tableName } from './client';
import { keys } from './keys';

/**
 * Remembers which career-page job URLs were already fetched, so each detail page is
 * downloaded once instead of every run (polite crawling, §5). Expires after 30 days.
 */
export interface SeenStore {
  unseen(urls: string[]): Promise<string[]>;
  markSeen(urls: string[], nowMs: number): Promise<void>;
}

const SEEN_TTL_DAYS = 30;
/** Wait before retrying items DynamoDB left unprocessed (throttling): 100, 200, 400… ms. */
const retryDelayMs = (attempt: number) => 100 * 2 ** attempt;
const hash = (url: string) => sha256Hex(url).slice(0, 32);

export const dynamoSeenStore: SeenStore = {
  async unseen(urls) {
    const seen = new Set<string>();
    for (let i = 0; i < urls.length; i += 100) {
      let request: Record<string, { Keys: Array<Record<string, unknown>> }> | undefined = {
        [tableName()]: { Keys: urls.slice(i, i + 100).map((u) => keys.seenPage(hash(u))), ProjectionExpression: 'PK' } as never,
      };
      for (let attempt = 0; request && attempt < 5; attempt++) {
        if (attempt > 0) await sleep(retryDelayMs(attempt - 1));
        const result: BatchGetCommandOutput = await ddb().send(new BatchGetCommand({ RequestItems: request }));
        for (const item of result.Responses?.[tableName()] ?? []) seen.add(String(item.PK));
        const rest: Array<Record<string, unknown>> | undefined = result.UnprocessedKeys?.[tableName()]?.Keys;
        request = rest?.length ? { [tableName()]: { Keys: rest, ProjectionExpression: 'PK' } as never } : undefined;
      }
    }
    return urls.filter((u) => !seen.has(keys.seenPage(hash(u)).PK));
  },

  async markSeen(urls, nowMs) {
    const unique = [...new Set(urls)];
    for (let i = 0; i < unique.length; i += 25) {
      let writes: Array<Record<string, unknown>> | undefined = unique.slice(i, i + 25).map((u) => ({
        PutRequest: { Item: { ...keys.seenPage(hash(u)), entity: 'SEEN', url: u, ttl: ttlAfterDays(nowMs, SEEN_TTL_DAYS) } },
      }));
      for (let attempt = 0; writes?.length && attempt < 5; attempt++) {
        if (attempt > 0) await sleep(retryDelayMs(attempt - 1));
        const result: BatchWriteCommandOutput = await ddb().send(new BatchWriteCommand({ RequestItems: { [tableName()]: writes as never } }));
        writes = result.UnprocessedItems?.[tableName()] as Array<Record<string, unknown>> | undefined;
      }
    }
  },
};
