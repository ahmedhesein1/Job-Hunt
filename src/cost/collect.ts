import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import { CloudWatchClient, DescribeAlarmsCommand, GetMetricStatisticsCommand, ListDashboardsCommand, type Dimension } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { FreeTierClient, GetAccountPlanStateCommand } from '@aws-sdk/client-freetier';
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { costSettings } from '../../config/pricing';
import { ddb, tableName } from '../data/client';
import { keys } from '../data/keys';
import { logger } from '../lib/logger';
import { DAY_MS, ttlAfterDays } from '../lib/time';
import type { AppUsage, BillingFacts, DailyUsage, LambdaUsage, LogGroupUsage, QueueUsage } from './types';

/**
 * §9 usage collection. Reads AWS's own measurements for complete UTC days with free APIs
 * only: GetMetricStatistics (not the paid GetMetricData), Describe* calls, the Budgets
 * actual-spend figure (not Cost Explorer, $0.01 per call) and the Free plan state.
 */
export interface MetricQuery {
  namespace: string;
  metric: string;
  dimensions: Dimension[];
  startMs: number;
  endMs: number;
}

export interface MetricStats {
  sum?: number | undefined;
  avg?: number | undefined;
  max?: number | undefined;
  p50?: number | undefined;
  p95?: number | undefined;
}

/** Everything the collector reads from AWS, injectable for tests. */
export interface UsageSources {
  metric(q: MetricQuery, percentiles: boolean): Promise<MetricStats>;
  functionConfig(name: string): Promise<{ memoryMb: number; timeoutSec: number; arch: 'arm64' | 'x86_64' } | undefined>;
  table(): Promise<{ provisionedRcu: number; provisionedWcu: number; storageBytes: number; indexes: string[] }>;
  logGroups(prefix: string): Promise<Array<{ name: string; storedBytes: number; retentionDays: number | undefined }>>;
  alarmCount(): Promise<number>;
  dashboardCount(): Promise<number>;
  appUsage(day: string): Promise<Record<string, unknown> | undefined>;
  budget(): Promise<BillingFacts['budget']>;
  plan(): Promise<BillingFacts['plan']>;
}

export interface CollectConfig {
  functions: string[];
  queueNames: string[];
  tableName: string;
  logGroupPrefix: string;
}

const LAMBDA = 'AWS/Lambda';

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** Complete UTC days before `nowMs`, newest first. */
export function previousDays(nowMs: number, count: number): string[] {
  const today = dayStartMs(dayKey(nowMs));
  return Array.from({ length: count }, (_, i) => dayKey(today - (i + 1) * DAY_MS));
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function parseAppUsage(item: Record<string, unknown> | undefined): AppUsage {
  const byHost: AppUsage['byHost'] = {};
  for (const [k, v] of Object.entries(item ?? {})) {
    const m = /^(req|bytes)#(.+)$/.exec(k);
    if (!m) continue;
    const host = m[2] as string;
    byHost[host] ??= { requests: 0, bytes: 0 };
    if (m[1] === 'req') byHost[host].requests = num(v);
    else byHost[host].bytes = num(v);
  }
  return {
    httpRequests: num(item?.httpRequests),
    httpBytes: num(item?.httpBytes),
    httpErrors: num(item?.httpErrors),
    browserPages: num(item?.browserPages),
    telegramRequests: num(item?.telegramRequests),
    telegramSent: num(item?.telegramSent),
    telegramFailed: num(item?.telegramFailed),
    telegramRateLimited: num(item?.telegramRateLimited),
    byHost,
  };
}

/** Collects one complete UTC day. Counts its own CloudWatch API calls. */
export async function collectDay(day: string, cfg: CollectConfig, src: UsageSources): Promise<DailyUsage> {
  const startMs = dayStartMs(day);
  const endMs = startMs + DAY_MS;
  let apiCalls = 0;
  const metric = async (namespace: string, name: string, dimensions: Dimension[], percentiles = false) => {
    apiCalls += 1;
    return src.metric({ namespace, metric: name, dimensions, startMs, endMs }, percentiles);
  };

  const lambda: LambdaUsage[] = [];
  for (const name of cfg.functions) {
    const conf = await src.functionConfig(name);
    if (!conf) continue;
    const dims = [{ Name: 'FunctionName', Value: name }];
    const [inv, err, thr, dur] = await Promise.all([
      metric(LAMBDA, 'Invocations', dims),
      metric(LAMBDA, 'Errors', dims),
      metric(LAMBDA, 'Throttles', dims),
      metric(LAMBDA, 'Duration', dims, true),
    ]);
    lambda.push({
      name,
      arch: conf.arch,
      memoryMb: conf.memoryMb,
      timeoutSec: conf.timeoutSec,
      invocations: num(inv.sum),
      errors: num(err.sum),
      throttles: num(thr.sum),
      durationSumMs: num(dur.sum),
      durationAvgMs: dur.avg,
      p50Ms: dur.p50,
      p95Ms: dur.p95,
      maxMs: dur.max,
      hitTimeout: dur.max !== undefined && dur.max >= conf.timeoutSec * 1000 - 100,
    });
  }

  const table = await src.table();
  const ddbTargets: Dimension[][] = [
    [{ Name: 'TableName', Value: cfg.tableName }],
    ...table.indexes.map((i) => [{ Name: 'TableName', Value: cfg.tableName }, { Name: 'GlobalSecondaryIndexName', Value: i }]),
  ];
  let consumedRcu = 0;
  let consumedWcu = 0;
  let readThrottles = 0;
  let writeThrottles = 0;
  for (const dims of ddbTargets) {
    const [r, w, rt, wt] = await Promise.all([
      metric('AWS/DynamoDB', 'ConsumedReadCapacityUnits', dims),
      metric('AWS/DynamoDB', 'ConsumedWriteCapacityUnits', dims),
      metric('AWS/DynamoDB', 'ReadThrottleEvents', dims),
      metric('AWS/DynamoDB', 'WriteThrottleEvents', dims),
    ]);
    consumedRcu += num(r.sum);
    consumedWcu += num(w.sum);
    readThrottles += num(rt.sum);
    writeThrottles += num(wt.sum);
  }

  const sqs: QueueUsage[] = [];
  for (const name of cfg.queueNames) {
    const dims = [{ Name: 'QueueName', Value: name }];
    const [sent, received, deleted, empty, visible, age] = await Promise.all([
      metric('AWS/SQS', 'NumberOfMessagesSent', dims),
      metric('AWS/SQS', 'NumberOfMessagesReceived', dims),
      metric('AWS/SQS', 'NumberOfMessagesDeleted', dims),
      metric('AWS/SQS', 'NumberOfEmptyReceives', dims),
      metric('AWS/SQS', 'ApproximateNumberOfMessagesVisible', dims),
      metric('AWS/SQS', 'ApproximateAgeOfOldestMessage', dims),
    ]);
    sqs.push({
      name,
      fifo: name.endsWith('.fifo'),
      sent: num(sent.sum),
      received: num(received.sum),
      deleted: num(deleted.sum),
      emptyReceives: num(empty.sum),
      maxVisible: num(visible.max),
      maxAgeSec: num(age.max),
    });
  }

  // Account-level Scheduler metrics (no dimensions).
  const [attempts, targetErrors, throttles, dropped] = await Promise.all([
    metric('AWS/Scheduler', 'InvocationAttemptCount', []),
    metric('AWS/Scheduler', 'TargetErrorCount', []),
    metric('AWS/Scheduler', 'InvocationThrottleCount', []),
    metric('AWS/Scheduler', 'InvocationDroppedCount', []),
  ]);

  const logs: LogGroupUsage[] = [];
  for (const g of await src.logGroups(cfg.logGroupPrefix)) {
    const incoming = await metric('AWS/Logs', 'IncomingBytes', [{ Name: 'LogGroupName', Value: g.name }]);
    logs.push({ name: g.name, ingestedBytes: num(incoming.sum), storedBytes: g.storedBytes, retentionDays: g.retentionDays });
  }

  const [alarms, dashboards, appItem] = await Promise.all([src.alarmCount(), src.dashboardCount(), src.appUsage(day)]);
  // Describe/List calls above are CloudWatch API requests too.
  apiCalls += 2;

  return {
    day,
    collectedAt: new Date().toISOString(),
    lambda,
    dynamodb: { consumedRcu, consumedWcu, readThrottles, writeThrottles, provisionedRcu: table.provisionedRcu, provisionedWcu: table.provisionedWcu, storageBytes: table.storageBytes },
    sqs,
    scheduler: { attempts: num(attempts.sum), targetErrors: num(targetErrors.sum), throttles: num(throttles.sum), dropped: num(dropped.sum) },
    logs,
    cloudwatch: { alarms, dashboards, apiRequestsByCollector: apiCalls },
    app: parseAppUsage(appItem),
  };
}

export async function collectBilling(src: UsageSources): Promise<BillingFacts> {
  const errors: string[] = [];
  const budget = await src.budget().catch((err: unknown) => {
    errors.push(`budget: ${(err as Error).name}`);
    return undefined;
  });
  const plan = await src.plan().catch((err: unknown) => {
    errors.push(`free plan: ${(err as Error).name}`);
    return undefined;
  });
  return { budget, plan, errors };
}

// ------------------------------------------------------------------ AWS implementation

export function awsUsageSources(opts: { tableName: string; accountId: string; budgetName: string }): UsageSources {
  const cw = new CloudWatchClient({});
  const logsClient = new CloudWatchLogsClient({});
  const dynamo = new DynamoDBClient({});
  const lambda = new LambdaClient({});
  // Budgets and the Free Tier API are served from us-east-1.
  const budgets = new BudgetsClient({ region: 'us-east-1' });
  const freeTierClient = new FreeTierClient({ region: 'us-east-1' });

  return {
    async metric(q, percentiles) {
      const res = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: q.namespace,
          MetricName: q.metric,
          Dimensions: q.dimensions,
          StartTime: new Date(q.startMs),
          EndTime: new Date(q.endMs),
          Period: Math.round((q.endMs - q.startMs) / 1000),
          Statistics: ['Sum', 'Average', 'Maximum'],
          ...(percentiles ? { ExtendedStatistics: ['p50', 'p95'] } : {}),
        }),
      );
      const points = res.Datapoints ?? [];
      if (points.length === 0) return {};
      const p = points[0]!;
      return { sum: p.Sum, avg: p.Average, max: p.Maximum, p50: p.ExtendedStatistics?.p50, p95: p.ExtendedStatistics?.p95 };
    },
    async functionConfig(name) {
      try {
        const c = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
        return { memoryMb: c.MemorySize ?? 128, timeoutSec: c.Timeout ?? 3, arch: c.Architectures?.[0] === 'x86_64' ? 'x86_64' : 'arm64' };
      } catch (err) {
        // A disabled feature (e.g. Gmail) may have no function deployed.
        if ((err as Error).name === 'ResourceNotFoundException') return undefined;
        throw err;
      }
    },
    async table() {
      const t = (await dynamo.send(new DescribeTableCommand({ TableName: opts.tableName }))).Table;
      const gsis = t?.GlobalSecondaryIndexes ?? [];
      return {
        provisionedRcu: num(t?.ProvisionedThroughput?.ReadCapacityUnits) + gsis.reduce((s, g) => s + num(g.ProvisionedThroughput?.ReadCapacityUnits), 0),
        provisionedWcu: num(t?.ProvisionedThroughput?.WriteCapacityUnits) + gsis.reduce((s, g) => s + num(g.ProvisionedThroughput?.WriteCapacityUnits), 0),
        storageBytes: num(t?.TableSizeBytes),
        indexes: gsis.map((g) => g.IndexName).filter((n): n is string => Boolean(n)),
      };
    },
    async logGroups(prefix) {
      const out: Array<{ name: string; storedBytes: number; retentionDays: number | undefined }> = [];
      let nextToken: string | undefined;
      do {
        const res = await logsClient.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken }));
        for (const g of res.logGroups ?? []) if (g.logGroupName) out.push({ name: g.logGroupName, storedBytes: num(g.storedBytes), retentionDays: g.retentionInDays });
        nextToken = res.nextToken;
      } while (nextToken);
      return out;
    },
    async alarmCount() {
      let count = 0;
      let nextToken: string | undefined;
      do {
        const res = await cw.send(new DescribeAlarmsCommand({ NextToken: nextToken, MaxRecords: 100 }));
        count += (res.MetricAlarms?.length ?? 0) + (res.CompositeAlarms?.length ?? 0);
        nextToken = res.NextToken;
      } while (nextToken);
      return count;
    },
    async dashboardCount() {
      return (await cw.send(new ListDashboardsCommand({}))).DashboardEntries?.length ?? 0;
    },
    async appUsage(day) {
      return (await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.appUsage(day) }))).Item;
    },
    async budget() {
      const b = (await budgets.send(new DescribeBudgetCommand({ AccountId: opts.accountId, BudgetName: opts.budgetName }))).Budget;
      if (!b) return undefined;
      return {
        name: b.BudgetName ?? opts.budgetName,
        limitUsd: Number(b.BudgetLimit?.Amount ?? 0),
        actualUsd: Number(b.CalculatedSpend?.ActualSpend?.Amount ?? 0),
        forecastUsd: b.CalculatedSpend?.ForecastedSpend?.Amount !== undefined ? Number(b.CalculatedSpend.ForecastedSpend.Amount) : undefined,
      };
    },
    async plan() {
      const p = await freeTierClient.send(new GetAccountPlanStateCommand({}));
      return {
        type: String(p.accountPlanType ?? 'unknown'),
        status: String(p.accountPlanStatus ?? 'unknown'),
        creditsUsd: p.accountPlanRemainingCredits?.amount,
        expires: p.accountPlanExpirationDate ? new Date(p.accountPlanExpirationDate).toISOString().slice(0, 10) : undefined,
      };
    },
  };
}

// ------------------------------------------------------------------ storage

export interface CostSnapshot {
  billing: BillingFacts;
  collectedAt: string;
  days: string[];
}

export async function saveDay(usage: DailyUsage, nowMs: number): Promise<void> {
  await ddb().send(new PutCommand({ TableName: tableName(), Item: { ...keys.costDay(usage.day), entity: 'COST_DAY', usage, ttl: ttlAfterDays(nowMs, 400) } }));
}

/** Most recent stored days, newest first. */
export async function loadDays(limit: number = costSettings.projectionWindowDays): Promise<DailyUsage[]> {
  const res = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :day)',
      ExpressionAttributeValues: { ':pk': 'COST', ':day': 'DAY#' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []).map((i) => i.usage as DailyUsage);
}

export async function saveSnapshot(snapshot: CostSnapshot, nowMs: number): Promise<void> {
  await ddb().send(new PutCommand({ TableName: tableName(), Item: { PK: 'COST', SK: 'LATEST', entity: 'COST_LATEST', ...snapshot, ttl: ttlAfterDays(nowMs, 400) } }));
}

export async function loadSnapshot(): Promise<CostSnapshot | undefined> {
  const item = (await ddb().send(new GetCommand({ TableName: tableName(), Key: { PK: 'COST', SK: 'LATEST' } }))).Item;
  return item ? { billing: item.billing as BillingFacts, collectedAt: String(item.collectedAt), days: (item.days as string[]) ?? [] } : undefined;
}

/**
 * Collects every complete day in the projection window that is not stored yet (first run
 * backfills up to 7 days from CloudWatch), then the billing facts.
 */
export async function runCollection(nowMs: number, cfg: CollectConfig, src: UsageSources, stored: Set<string>): Promise<{ collected: string[]; billing: BillingFacts }> {
  const collected: string[] = [];
  for (const day of previousDays(nowMs, costSettings.projectionWindowDays)) {
    if (stored.has(day)) continue;
    try {
      await saveDay(await collectDay(day, cfg, src), nowMs);
      collected.push(day);
    } catch (err) {
      logger.warn('usage collection failed for day', { day, error: err });
    }
  }
  return { collected, billing: await collectBilling(src) };
}
