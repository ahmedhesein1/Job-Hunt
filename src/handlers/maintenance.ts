import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { gzipSync } from 'node:zlib';
import { limits } from '../../config/limits';
import { sources, type SourceId } from '../../config/sources';
import { ddb, tableName } from '../data/client';
import { batchGetJobs, queryByStatus, type JobItem } from '../data/jobs';
import { keys, type UserStatus } from '../data/keys';
import { pendingSummary, putTextNotification } from '../data/outbox';
import { getSettings } from '../data/settings';
import { getSourceStates, queryRuns } from '../data/sources';
import { getRateState, reserveSendSlot } from '../data/telegram-updates';
import { logger } from '../lib/logger';
import { telegramChatId } from '../lib/secrets';
import { cairoDayKey, DAY_MS, HOUR_MS, iso, relativeAge, sleep } from '../lib/time';
import { escapeHtml, joinWithinLimit, skillLabel } from '../notifications/formatting';
import { sqsClient } from '../notifications/queue';
import { sendDocument } from '../telegram/bot';
import { withUsage } from '../lib/usage';
import { costSettings } from '../../config/pricing';
import { awsUsageSources, loadDays, loadSnapshot, runCollection, saveSnapshot, type CollectConfig } from '../cost/collect';
import { buildCostReport, costHealthLine } from '../cost/report';

type Task = 'health' | 'weekly-report' | 'backup' | 'cost';

const cloudwatch = new CloudWatchClient({});

async function queueDepth(envName: string): Promise<number> {
  const url = process.env[envName];
  if (!url) return 0;
  const result = await sqsClient().send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }));
  return Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
}

async function metricSum(namespace: string, metric: string, dimensions: Array<{ Name: string; Value: string }>, nowMs: number): Promise<number> {
  const result = await cloudwatch.send(
    new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: metric,
      Dimensions: dimensions,
      StartTime: new Date(nowMs - DAY_MS),
      EndTime: new Date(nowMs),
      Period: 86_400,
      Statistics: ['Sum'],
    }),
  );
  return (result.Datapoints ?? []).reduce((sum, d) => sum + (d.Sum ?? 0), 0);
}

/** §13 daily health checks. Returns human-readable issues (empty = healthy). */
export async function healthIssues(nowMs: number): Promise<string[]> {
  const issues: string[] = [];
  const ids = (Object.keys(sources) as SourceId[]).filter((id) => sources[id].enabled);
  const states = await getSourceStates(ids);
  for (const state of states) {
    const p = sources[state.sourceId as SourceId];
    if (state.breaker.status === 'MANUAL_REVIEW' || state.breaker.status === 'UNAVAILABLE') {
      issues.push(`🔴 ${p.name} paused: ${state.breaker.pausedReason ?? state.breaker.status} — review, then /resume ${p.id}`);
    } else if (state.breaker.status !== 'CLOSED') {
      issues.push(`🟠 ${p.name} in ${state.breaker.status}`);
    }
    if (p.staleAfterMinutes !== undefined && (state.lastSuccessAt === undefined || nowMs - state.lastSuccessAt > p.staleAfterMinutes * 60_000)) {
      issues.push(`🟡 ${p.name} stale: last success ${state.lastSuccessAt ? relativeAge(state.lastSuccessAt, nowMs) : 'never'}`);
    }
    if (state.hasProducedMatches && state.zeroMatchStreak >= limits.health.zeroMatchWarnAfter) {
      issues.push(`🟡 ${p.name}: ${state.zeroMatchStreak} successful checks with zero matches (may be fine; worth a look)`);
    }
  }

  const [dlq, streamDlq, pending] = await Promise.all([queueDepth('NOTIFICATION_DLQ_URL'), queueDepth('STREAM_FAILURE_QUEUE_URL'), pendingSummary()]);
  if (dlq > 0) issues.push(`🔴 Notification DLQ has ${dlq} message(s)`);
  if (streamDlq > 0) issues.push(`🔴 Stream failure queue has ${streamDlq} record(s)`);
  const oldestAge = pending.oldestCreatedAt ? nowMs - Date.parse(pending.oldestCreatedAt) : 0;
  if (pending.count >= limits.notifications.outboxPendingAlertCount || oldestAge > limits.notifications.outboxPendingAlertAgeMs) {
    issues.push(`🟠 Outbox pending: ${pending.count} (oldest ${pending.oldestCreatedAt ? relativeAge(Date.parse(pending.oldestCreatedAt), nowMs) : 'n/a'})`);
  }

  const rate = await getRateState(telegramChatId());
  const lastLimited = Number(rate?.lastRateLimitedAt ?? 0);
  if (lastLimited > nowMs - DAY_MS) issues.push('🟠 Telegram returned 429 in the last 24 h');

  const functions = (process.env.MONITORED_FUNCTIONS ?? '').split(',').filter(Boolean);
  for (const fn of functions) {
    const [errors, throttles] = await Promise.all([
      metricSum('AWS/Lambda', 'Errors', [{ Name: 'FunctionName', Value: fn }], nowMs),
      metricSum('AWS/Lambda', 'Throttles', [{ Name: 'FunctionName', Value: fn }], nowMs),
    ]);
    if (errors > 0 || throttles > 0) issues.push(`🟠 Lambda ${fn}: ${errors} error(s), ${throttles} throttle(s) in 24 h`);
  }
  const table = tableName();
  const [readThrottles, writeThrottles] = await Promise.all([
    metricSum('AWS/DynamoDB', 'ReadThrottleEvents', [{ Name: 'TableName', Value: table }], nowMs),
    metricSum('AWS/DynamoDB', 'WriteThrottleEvents', [{ Name: 'TableName', Value: table }], nowMs),
  ]);
  if (readThrottles + writeThrottles > 0) issues.push(`🟠 DynamoDB throttling: ${readThrottles} read / ${writeThrottles} write events in 24 h`);
  return issues;
}

async function runHealth(nowMs: number): Promise<void> {
  const issues = await healthIssues(nowMs);
  const cost = await costLine();
  const text =
    issues.length === 0
      ? ['🩺 <b>Daily health</b>: all sources and queues healthy.', ...(cost ? [cost] : [])].join('\n')
      : joinWithinLimit(['🩺 <b>Daily health</b>', ''], [...issues.map((i) => escapeHtml(i)), ...(cost ? [cost] : [])]).text;
  await putTextNotification(`health:${cairoDayKey(nowMs)}`, text, nowMs);
}

// ------------------------------------------------------------------ §9 cost and usage

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

/** Every function and queue of this stack, from the environment set in template.yaml. */
export function collectConfig(): CollectConfig {
  const self = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const queueName = (url: string | undefined) => (url ? decodeURIComponent(url.split('/').pop() ?? '') : '');
  return {
    functions: [...new Set([...list(process.env.MONITORED_FUNCTIONS), ...(self ? [self] : [])])],
    queueNames: [process.env.NOTIFICATION_QUEUE_URL, process.env.NOTIFICATION_DLQ_URL, process.env.STREAM_FAILURE_QUEUE_URL].map(queueName).filter(Boolean),
    tableName: tableName(),
    logGroupPrefix: `/aws/lambda/${process.env.STACK_NAME ?? 'job-finder'}-`,
  };
}

async function costLine(): Promise<string | undefined> {
  try {
    const snapshot = await loadSnapshot();
    const days = await loadDays();
    return costHealthLine(buildCostReport(days, snapshot?.billing ?? { errors: [] }));
  } catch (err) {
    logger.warn('cost line failed', { error: err });
    return undefined;
  }
}

/**
 * Collects any missing complete days (first run backfills the window), refreshes the
 * billing facts and stores a snapshot. Sends the report when asked (/cost refresh) and,
 * at most once a day, when the projection or actual spend nears the budget.
 */
async function runCost(nowMs: number, notify: boolean): Promise<void> {
  const accountId = process.env.ACCOUNT_ID ?? '';
  const src = awsUsageSources({ tableName: tableName(), accountId, budgetName: process.env.BUDGET_NAME ?? costSettings.budgetName });
  const stored = new Set((await loadDays(costSettings.projectionWindowDays + 2)).map((d) => d.day));
  const { collected, billing } = await runCollection(nowMs, collectConfig(), src, stored);
  const days = await loadDays();
  await saveSnapshot({ billing, collectedAt: new Date(nowMs).toISOString(), days: days.map((d) => d.day) }, nowMs);
  const report = buildCostReport(days, billing);
  logger.info('cost collection complete', { collected, days: days.length, level: report.level, expectedUsd: report.scenarios?.expected.totalUsd, actualUsd: billing.budget?.actualUsd, billingErrors: billing.errors });
  if (notify) await putTextNotification(`cost:${nowMs}`, report.text, nowMs);
  else if (report.level === 'warn' || report.level === 'over') await putTextNotification(`cost-warning:${cairoDayKey(nowMs)}`, report.text, nowMs);
}

async function countStatus(status: UserStatus, sinceIso: string): Promise<number> {
  return (await queryByStatus(status, sinceIso, 1000)).length;
}

/** §13 weekly report. */
export async function buildWeeklyReport(nowMs: number): Promise<string> {
  const since = iso(nowMs - 7 * DAY_MS);
  const lines = ['📊 <b>Weekly report</b>', ''];
  let duplicates = 0;
  for (const id of Object.keys(sources) as SourceId[]) {
    const p = sources[id];
    if (!p.enabled) continue;
    const runs = await queryRuns(id, since);
    const sum = runs.reduce(
      (acc, r) => ({ found: acc.found + (r.found ?? 0), kept: acc.kept + (r.kept ?? 0), alerts: acc.alerts + (r.alerts ?? 0), failed: acc.failed + (r.status === 'FAILED' ? 1 : 0) }),
      { found: 0, kept: 0, alerts: 0, failed: 0 },
    );
    duplicates += runs.reduce((acc, r) => acc + (r.duplicates ?? 0), 0);
    lines.push(`• ${escapeHtml(p.name)}: ${runs.length} runs, ${sum.found} found, ${sum.kept} eligible, ${sum.alerts} alerts${sum.failed ? `, ${sum.failed} failed` : ''}`);
  }
  const [states] = await Promise.all([getSourceStates((Object.keys(sources) as SourceId[]).filter((id) => sources[id].enabled))]);
  const freshness = states
    .map((s) => `${sources[s.sourceId as SourceId].name} ${s.lastChangeAt ? relativeAge(s.lastChangeAt, nowMs) : 'never'}`)
    .join(' · ');
  lines.push('', `Duplicates suppressed: ${duplicates}`, `Last new data: ${escapeHtml(freshness)}`);

  const allTime = '0';
  const counts = await Promise.all((['Saved', 'Applied', 'Interview', 'Offer'] as UserStatus[]).map((s) => countStatus(s, allTime)));
  lines.push('', `Pipeline: ⭐ ${counts[0]} saved · ✅ ${counts[1]} applied · 🗣 ${counts[2]} interview · 🏆 ${counts[3]} offer`);

  const dismissed = await queryByStatus('Dismissed', iso(nowMs - 30 * DAY_MS), 500);
  const reasons = new Map<string, number>();
  for (const j of dismissed) reasons.set(j.dismissReason ?? 'other', (reasons.get(j.dismissReason ?? 'other') ?? 0) + 1);
  if (reasons.size > 0) {
    lines.push(`Dismiss reasons (30 d): ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${escapeHtml(r)} ${n}`).join(', ')}`);
  }

  const recent: JobItem[] = await queryByStatus('New', since, 500);
  const skills = new Map<string, number>();
  for (const j of recent) for (const s of j.skills) skills.set(s, (skills.get(s) ?? 0) + 1);
  const topSkills = [...skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (topSkills.length > 0) lines.push(`Top skills in matches: ${topSkills.map(([s, n]) => `${escapeHtml(skillLabel(s))} ${n}`).join(', ')}`);
  return joinWithinLimit(lines, []).text;
}

/** §13 weekly backup: the user's own records/settings/history as gzipped JSON. */
export async function buildBackup(nowMs: number): Promise<{ filename: string; content: Uint8Array; jobs: number }> {
  const statuses: UserStatus[] = ['Saved', 'Applied', 'Interview', 'Offer', 'Dismissed'];
  const ids: string[] = [];
  for (const status of statuses) ids.push(...(await queryByStatus(status, '0', 5000)).map((j) => j.jobId));
  // GSI1 projects list fields only; read the full base items for the backup.
  const jobs: Array<JobItem & { events?: unknown[] }> = await batchGetJobs(ids);
  for (const job of jobs) {
    const events = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :ev)',
        ExpressionAttributeValues: { ':pk': keys.job(job.jobId).PK, ':ev': 'EVENT#' },
      }),
    );
    job.events = events.Items ?? [];
  }
  const settings = await getSettings();
  const payload = {
    exportedAt: iso(nowMs),
    settings: { ...settings, mutedCompanies: [...settings.mutedCompanies] },
    jobs: jobs.map((j) => ({ ...j, sources: [...(j.sources ?? [])] })),
  };
  const content = gzipSync(Buffer.from(JSON.stringify(payload)));
  return { filename: `jobfinder-backup-${cairoDayKey(nowMs)}.json.gz`, content, jobs: jobs.length };
}

async function sendBackup(nowMs: number): Promise<void> {
  const backup = await buildBackup(nowMs);
  if (backup.content.byteLength > 45 * 1024 * 1024) {
    await putTextNotification(`backup-too-large:${cairoDayKey(nowMs)}`, '⚠️ Weekly backup exceeds Telegram’s file limit; S3 backup storage is needed (plan §13).', nowMs);
    return;
  }
  const chatId = telegramChatId();
  for (let attempt = 0; attempt < 5; attempt++) {
    const slot = await reserveSendSlot(chatId, Date.now());
    if (slot.ok) {
      await sendDocument(chatId, backup.filename, backup.content, `🗄 Weekly backup — ${backup.jobs} tracked job(s)`);
      return;
    }
    await sleep(Math.min(slot.waitMs, 5_000) + 50);
  }
  throw new Error('Could not reserve a Telegram send slot for the backup');
}

async function handle(event: { task?: unknown; notify?: unknown }): Promise<{ task: Task }> {
  const nowMs = Date.now();
  const task = event.task as Task;
  switch (task) {
    case 'health':
      await runHealth(nowMs);
      break;
    case 'weekly-report':
      await putTextNotification(`weekly-report:${cairoDayKey(nowMs)}`, await buildWeeklyReport(nowMs), nowMs);
      break;
    case 'backup':
      await sendBackup(nowMs);
      break;
    case 'cost':
      await runCost(nowMs, event.notify === true);
      break;
    default:
      throw new Error(`Unknown maintenance task: ${String(event.task)}`);
  }
  logger.info('maintenance task complete', { task, durationMs: Date.now() - nowMs, hours: (Date.now() - nowMs) / HOUR_MS });
  return { task };
}

/** §9: usage counters (HTTP, Telegram) are flushed once per invocation. */
export const handler = withUsage(handle);
