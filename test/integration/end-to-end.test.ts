import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sources } from '../../config/sources';
import { processJobs } from '../../src/core/pipeline';
import { getNotification, jobNotificationId } from '../../src/data/outbox';
import { defaultSettings } from '../../src/data/settings';
import { parseRemoteOkJob } from '../../src/sources/remoteok';
import { setTelegramFetch } from '../../src/telegram/bot';
import { fixtureJson } from '../helpers/fixtures';
import { createTestTable, dropTestTable } from './helpers';

/**
 * §16 end-to-end: fixture → normalized job → DynamoDB job/outbox → (stream) dispatcher →
 * SQS FIFO → sender → Telegram payload. SQS is replaced by an in-memory FIFO; DynamoDB
 * is real (DynamoDB Local); Telegram is a recorded fetch.
 */
const queue = vi.hoisted(() => ({ messages: [] as Array<{ body: string; groupId: string; dedupeId: string }> }));
vi.mock('../../src/notifications/queue', async (orig) => ({
  ...(await orig<typeof import('../../src/notifications/queue')>()),
  enqueueNotification: vi.fn(async (notificationId: string) => {
    if (!queue.messages.some((m) => m.dedupeId === notificationId)) {
      queue.messages.push({ body: JSON.stringify({ notificationId }), groupId: '123456789', dedupeId: notificationId });
    }
  }),
  delayMessage: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/secrets', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/secrets')>()),
  telegramBotToken: async () => '123:TEST',
}));

let table: string;
beforeAll(async () => {
  table = await createTestTable();
});
afterAll(async () => dropTestTable(table));

describe('fixture → Telegram (end-to-end)', () => {
  it('delivers exactly one alert per new matching job, rate-limited and idempotent', async () => {
    const body = fixtureJson<unknown[]>('remoteok.json');
    const jobs = body.map(parseRemoteOkJob).filter((j) => j !== undefined);
    // Pin "now" right after the newest fixture job so nothing is stale or out of window.
    const newest = Math.max(...jobs.map((j) => Date.parse(j.publishedAt!)));
    const nowMs = newest + 3_600_000;
    // Make every fixture job a remote-worldwide Node backend role so the pipeline keeps it.
    const matching = jobs.map((j, i) => ({
      ...j,
      title: `Backend Node.js Engineer ${i}`,
      location: 'Worldwide',
      description: 'Node.js TypeScript PostgreSQL backend services. 2+ years of experience. '.repeat(6),
      descriptionIsHtml: false,
    }));

    // Quiet hours off so the result does not depend on the fixture's time of day.
    const settings = { ...defaultSettings(), quietHours: { startHour: 0, endHour: 0 } };
    const stats = await processJobs(matching, { policy: sources.remoteok, settings, bootstrapped: true, sinceMs: 0, nowMs });
    expect(stats.stored).toBe(matching.length);
    expect(stats.alerts).toBeGreaterThan(0);

    // Simulate the DynamoDB stream INSERT records for the outbox items.
    const { handler: dispatch } = await import('../../src/handlers/dispatch-notification');
    const { normalizeJob } = await import('../../src/core/normalize');
    const { profiles } = await import('../../config/profiles');
    const records = matching.map((j, i) => {
      const jobId = normalizeJob(j, profiles[0]!, nowMs).jobId;
      const image = marshall({ PK: `NOTIF#${jobNotificationId(jobId)}`, SK: 'META', entity: 'NOTIF', status: 'PENDING' });
      return { eventName: 'INSERT', dynamodb: { SequenceNumber: String(i + 1), NewImage: image as Record<string, AttributeValue> } };
    });
    const streamEvent = { Records: records } as unknown as DynamoDBStreamEvent;
    expect((await dispatch(streamEvent)).batchItemFailures).toEqual([]);
    // Duplicate stream delivery is harmless (FIFO dedupe + status checks).
    await dispatch(streamEvent);
    expect(queue.messages).toHaveLength(stats.alerts);

    // Sender: one message at a time, recording Telegram payloads.
    const sent: Array<{ text: string; reply_markup?: unknown }> = [];
    setTelegramFetch(async (_url, init) => {
      const payload = JSON.parse(String(init.body)) as { text: string; reply_markup?: unknown };
      sent.push(payload);
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { headers: { 'content-type': 'application/json' } });
    });
    const { handler: send } = await import('../../src/handlers/send-notification');
    const sqsEvent = (body: string, id: string) => ({ Records: [{ messageId: id, receiptHandle: `rh-${id}`, body }] }) as unknown as SQSEvent;

    for (const [i, message] of queue.messages.entries()) {
      // Respect the 1.1 s slot: retry the same message until the sender accepts it.
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await send(sqsEvent(message.body, `m${i}`));
        if (res.batchItemFailures.length === 0) break;
        await new Promise((r) => setTimeout(r, 1150));
      }
    }
    expect(sent).toHaveLength(stats.alerts);
    expect(sent[0]!.text).toMatch(/^🎯 <b>Backend Node\.js Engineer/);
    expect(sent[0]!.text).toContain('via <a href="https://remoteok.com/remote-jobs/');
    expect(JSON.stringify(sent[0]!.reply_markup)).toContain('Apply ↗');

    // Redelivery after SENT never sends again (must-pass 9).
    await send(sqsEvent(queue.messages[0]!.body, 'dup'));
    expect(sent).toHaveLength(stats.alerts);
    const first = JSON.parse(queue.messages[0]!.body) as { notificationId: string };
    expect((await getNotification(first.notificationId))?.status).toBe('SENT');
  }, 60_000);
});
