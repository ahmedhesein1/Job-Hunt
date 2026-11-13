import { costSettings, freeTier, pricing } from '../../config/pricing';
import type { CostEstimate, CostLine, DailyUsage } from './types';

const GB = 1024 ** 3;

/** Monthly quantities derived from measured days. */
export interface MonthlyUsage {
  lambdaRequests: number;
  gbSecondsArm: number;
  gbSecondsX86: number;
  /** Provisioned units (table + GSIs); billed per hour whether used or not. */
  provisionedRcu: number;
  provisionedWcu: number;
  dynamoStorageGb: number;
  sqsFifoRequests: number;
  sqsStandardRequests: number;
  logIngestGb: number;
  logStoredGb: number;
  cloudwatchApiRequests: number;
  alarms: number;
  dashboards: number;
  schedulerInvocations: number;
  dataOutGb: number;
}

export function gbSeconds(durationSumMs: number, memoryMb: number): number {
  return (durationSumMs / 1000) * (memoryMb / 1024);
}

/**
 * SQS API requests for one queue-day. Lambda's event-source poller issues long-poll
 * ReceiveMessage calls continuously; empty ones are counted by NumberOfEmptyReceives.
 * Messages are sent, received and deleted in batches of up to 10, so this upper bound
 * counts one request per message for each operation.
 */
export function sqsRequests(q: DailyUsage['sqs'][number]): number {
  return q.sent + q.received + q.deleted + q.emptyReceives;
}

/** Outbound bytes: requests we send (headers ≈ 600 B; Telegram calls ≈ 2 KB). Inbound is free. */
export function estimatedEgressBytes(app: DailyUsage['app']): number {
  return app.httpRequests * 600 + app.browserPages * 4_000 + app.telegramRequests * 2_048;
}

type DayPick = (values: number[]) => number;
const avg: DayPick = (v) => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);
const min: DayPick = (v) => (v.length === 0 ? 0 : Math.min(...v));
const max: DayPick = (v) => (v.length === 0 ? 0 : Math.max(...v));

/**
 * Scales measured days to a 30-day month. `pick` chooses the day statistic per quantity:
 * min for the low scenario, average for expected, max for high.
 */
export function monthlyFromDays(days: DailyUsage[], pick: DayPick = avg): MonthlyUsage {
  if (days.length === 0) throw new Error('no usage days to project from');
  const perDay = (f: (d: DailyUsage) => number) => pick(days.map(f)) * costSettings.daysPerMonth;
  const latest = days.reduce((a, b) => (a.day > b.day ? a : b));
  const lambdaGb = (arch: 'arm64' | 'x86_64') => (d: DailyUsage) =>
    d.lambda.filter((l) => l.arch === arch).reduce((s, l) => s + gbSeconds(l.durationSumMs, l.memoryMb), 0);
  return {
    lambdaRequests: perDay((d) => d.lambda.reduce((s, l) => s + l.invocations, 0)),
    gbSecondsArm: perDay(lambdaGb('arm64')),
    gbSecondsX86: perDay(lambdaGb('x86_64')),
    provisionedRcu: latest.dynamodb.provisionedRcu,
    provisionedWcu: latest.dynamodb.provisionedWcu,
    dynamoStorageGb: latest.dynamodb.storageBytes / GB,
    sqsFifoRequests: perDay((d) => d.sqs.filter((q) => q.fifo).reduce((s, q) => s + sqsRequests(q), 0)),
    sqsStandardRequests: perDay((d) => d.sqs.filter((q) => !q.fifo).reduce((s, q) => s + sqsRequests(q), 0)),
    logIngestGb: perDay((d) => d.logs.reduce((s, g) => s + g.ingestedBytes, 0)) / GB,
    logStoredGb: latest.logs.reduce((s, g) => s + g.storedBytes, 0) / GB,
    cloudwatchApiRequests: perDay((d) => d.cloudwatch.apiRequestsByCollector),
    alarms: latest.cloudwatch.alarms,
    dashboards: latest.cloudwatch.dashboards,
    schedulerInvocations: perDay((d) => d.scheduler.attempts),
    dataOutGb: perDay((d) => estimatedEgressBytes(d.app)) / GB,
  };
}

function line(service: string, item: string, quantity: number, unit: string, freeAllowance: number, unitPrice: number): CostLine {
  const billable = Math.max(0, quantity - freeAllowance);
  return { service, item, quantity, unit, freeAllowance, billable, usd: billable * unitPrice };
}

/** Per-service monthly cost; each service's free allowance is applied separately. */
export function estimateMonthlyCost(m: MonthlyUsage, marginPct: number = costSettings.safetyMarginPct): CostEstimate {
  const h = costSettings.hoursPerMonth;
  const lines: CostLine[] = [];
  lines.push(line('Lambda', 'requests', m.lambdaRequests, 'requests', freeTier.lambdaRequests, pricing.lambda.request));

  // The 400,000 GB-s allowance covers both architectures; it is applied to the more
  // expensive x86 seconds first (an upper bound if AWS allocates it differently).
  const freeX86 = Math.min(m.gbSecondsX86, freeTier.lambdaGbSeconds);
  const freeArm = Math.min(m.gbSecondsArm, freeTier.lambdaGbSeconds - freeX86);
  lines.push(line('Lambda', 'compute arm64', m.gbSecondsArm, 'GB-s', freeArm, pricing.lambda.gbSecondArm));
  lines.push(line('Lambda', 'compute x86_64', m.gbSecondsX86, 'GB-s', freeX86, pricing.lambda.gbSecondX86));

  lines.push(line('DynamoDB', 'provisioned reads', m.provisionedRcu * h, 'RCU-hours', freeTier.dynamodbRcu * h, pricing.dynamodb.rcuHour));
  lines.push(line('DynamoDB', 'provisioned writes', m.provisionedWcu * h, 'WCU-hours', freeTier.dynamodbWcu * h, pricing.dynamodb.wcuHour));
  lines.push(line('DynamoDB', 'storage', m.dynamoStorageGb, 'GB-month', freeTier.dynamodbStorageGb, pricing.dynamodb.storageGbMonth));

  // One SQS allowance for standard + FIFO: applied to the pricier FIFO requests first.
  const freeFifo = Math.min(m.sqsFifoRequests, freeTier.sqsRequests);
  lines.push(line('SQS', 'FIFO requests', m.sqsFifoRequests, 'requests', freeFifo, pricing.sqs.fifoRequest));
  lines.push(line('SQS', 'standard requests', m.sqsStandardRequests, 'requests', freeTier.sqsRequests - freeFifo, pricing.sqs.standardRequest));

  // One 5 GB logs allowance for ingestion + storage: applied to ingestion first.
  const freeIngest = Math.min(m.logIngestGb, freeTier.cloudwatchLogsGb);
  lines.push(line('CloudWatch', 'log ingestion', m.logIngestGb, 'GB', freeIngest, pricing.cloudwatch.logIngestGb));
  lines.push(line('CloudWatch', 'log storage', m.logStoredGb, 'GB-month', freeTier.cloudwatchLogsGb - freeIngest, pricing.cloudwatch.logStorageGbMonth));
  lines.push(line('CloudWatch', 'API requests', m.cloudwatchApiRequests, 'requests', freeTier.cloudwatchApiRequests, pricing.cloudwatch.apiRequest));
  lines.push(line('CloudWatch', 'alarms', m.alarms, 'alarms', freeTier.cloudwatchAlarms, pricing.cloudwatch.alarmMonth));
  lines.push(line('CloudWatch', 'dashboards', m.dashboards, 'dashboards', freeTier.cloudwatchDashboards, pricing.cloudwatch.dashboardMonth));

  lines.push(line('EventBridge Scheduler', 'invocations', m.schedulerInvocations, 'invocations', freeTier.schedulerInvocations, pricing.scheduler.invocation));
  lines.push(line('Data transfer', 'egress (estimated)', m.dataOutGb, 'GB', freeTier.dataTransferOutGb, pricing.dataTransfer.outGb));

  const subtotalUsd = lines.reduce((s, l) => s + l.usd, 0);
  return { lines, subtotalUsd, marginPct, totalUsd: subtotalUsd * (1 + marginPct / 100) };
}

export interface Scenarios {
  days: number;
  low: CostEstimate;
  expected: CostEstimate;
  high: CostEstimate;
  expectedUsage: MonthlyUsage;
}

/** Low / expected / high from the quietest, average and busiest measured day. */
export function projectScenarios(days: DailyUsage[]): Scenarios {
  const expectedUsage = monthlyFromDays(days, avg);
  return {
    days: days.length,
    low: estimateMonthlyCost(monthlyFromDays(days, min)),
    expected: estimateMonthlyCost(expectedUsage),
    high: estimateMonthlyCost(monthlyFromDays(days, max)),
    expectedUsage,
  };
}

export type BudgetLevel = 'ok' | 'warn' | 'over';

/** Compares projected and actual figures with the budget limit. */
export function budgetLevel(limitUsd: number, values: number[], warnAtPct: number = costSettings.warnAtBudgetPct): BudgetLevel {
  const worst = Math.max(0, ...values.filter((v) => Number.isFinite(v)));
  if (worst >= limitUsd) return 'over';
  if (worst >= (limitUsd * warnAtPct) / 100) return 'warn';
  return 'ok';
}
