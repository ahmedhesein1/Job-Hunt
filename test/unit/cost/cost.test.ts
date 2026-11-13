import { describe, expect, it, vi } from 'vitest';
import { limits } from '../../../config/limits';
import { linkedinSearches } from '../../../config/linkedin-searches';
import { freeTier, pricing } from '../../../config/pricing';
import { collectDay, dayStartMs, parseAppUsage, previousDays, type MetricQuery, type UsageSources } from '../../../src/cost/collect';
import { budgetLevel, estimateMonthlyCost, gbSeconds, monthlyFromDays, projectScenarios, sqsRequests, type MonthlyUsage } from '../../../src/cost/estimate';
import { buildCostReport, costHealthLine } from '../../../src/cost/report';
import type { DailyUsage } from '../../../src/cost/types';

const ZERO: MonthlyUsage = {
  lambdaRequests: 0,
  gbSecondsArm: 0,
  gbSecondsX86: 0,
  provisionedRcu: 0,
  provisionedWcu: 0,
  dynamoStorageGb: 0,
  sqsFifoRequests: 0,
  sqsStandardRequests: 0,
  logIngestGb: 0,
  logStoredGb: 0,
  cloudwatchApiRequests: 0,
  alarms: 0,
  dashboards: 0,
  schedulerInvocations: 0,
  dataOutGb: 0,
};

function day(d: string, scale = 1): DailyUsage {
  return {
    day: d,
    collectedAt: `${d}T00:20:00Z`,
    lambda: [
      { name: 'job-finder-sync-company-boards', arch: 'arm64', memoryMb: 512, timeoutSec: 60, invocations: 1440 * scale, errors: 0, throttles: 0, durationSumMs: 1440 * 4000 * scale, durationAvgMs: 4000, p50Ms: 3500, p95Ms: 9000, maxMs: 20_000, hitTimeout: false },
      { name: 'job-finder-sync-rendered-pages', arch: 'x86_64', memoryMb: 1600, timeoutSec: 180, invocations: 8 * scale, errors: 1, throttles: 0, durationSumMs: 8 * 30_000 * scale, durationAvgMs: 30_000, p50Ms: 29_000, p95Ms: 40_000, maxMs: 180_000, hitTimeout: true },
    ],
    dynamodb: { consumedRcu: 20_000 * scale, consumedWcu: 9_000 * scale, readThrottles: 0, writeThrottles: 0, provisionedRcu: 15, provisionedWcu: 15, storageBytes: 50 * 1024 * 1024 },
    sqs: [{ name: 'notify.fifo', fifo: true, sent: 30 * scale, received: 30 * scale, deleted: 30 * scale, emptyReceives: 21_600, maxVisible: 1, maxAgeSec: 4 }],
    scheduler: { attempts: 1_900 * scale, targetErrors: 0, throttles: 0, dropped: 0 },
    logs: [{ name: '/aws/lambda/job-finder-sync-company-boards', ingestedBytes: 20 * 1024 * 1024 * scale, storedBytes: 200 * 1024 * 1024, retentionDays: 14 }],
    cloudwatch: { alarms: 6, dashboards: 1, apiRequestsByCollector: 90 },
    app: { httpRequests: 25_000 * scale, httpBytes: 900 * 1024 * 1024 * scale, httpErrors: 3, browserPages: 20, telegramRequests: 40, telegramSent: 35, telegramFailed: 1, telegramRateLimited: 0, byHost: {} },
  };
}

describe('workload for the 3-minute LinkedIn cycle (§5)', () => {
  it('distinguishes cycles, orchestrator invocations and search executions', () => {
    const cyclesPerDay = (24 * 60) / limits.linkedinSearch.cycleMinutes;
    expect(linkedinSearches).toHaveLength(39);
    expect(cyclesPerDay).toBe(480);
    expect(cyclesPerDay * 30).toBe(14_400); // scheduler invocations = orchestrator invocations
    expect(cyclesPerDay * 30 * linkedinSearches.length).toBe(561_600); // individual search executions
  });

  it('fits a 14,400-invocation orchestrator inside the Lambda request allowance', () => {
    const est = estimateMonthlyCost({ ...ZERO, lambdaRequests: 14_400, gbSecondsArm: 14_400 * 0.5 * 0.5 });
    expect(est.lines.find((l) => l.item === 'requests')?.usd).toBe(0);
    expect(est.totalUsd).toBe(0);
  });
});

describe('cost estimator', () => {
  it('computes GB-seconds from duration and memory', () => {
    expect(gbSeconds(2_000, 512)).toBe(1);
    expect(gbSeconds(1_000, 1600)).toBeCloseTo(1.5625);
  });

  it('applies each service allowance separately and prices only the excess', () => {
    const est = estimateMonthlyCost({ ...ZERO, lambdaRequests: 1_500_000, sqsFifoRequests: 1_200_000, schedulerInvocations: 1_000_000 }, 0);
    expect(est.lines.find((l) => l.service === 'Lambda' && l.item === 'requests')).toMatchObject({ billable: 500_000, usd: 500_000 * pricing.lambda.request });
    expect(est.lines.find((l) => l.item === 'FIFO requests')).toMatchObject({ billable: 200_000, usd: 200_000 * pricing.sqs.fifoRequest });
    // Scheduler has its own 14M allowance; it does not share Lambda's or SQS's.
    expect(est.lines.find((l) => l.service === 'EventBridge Scheduler')?.usd).toBe(0);
    expect(est.totalUsd).toBeCloseTo(0.1 + 0.1);
  });

  it('shares one SQS allowance between FIFO and standard queues, FIFO first', () => {
    const est = estimateMonthlyCost({ ...ZERO, sqsFifoRequests: 800_000, sqsStandardRequests: 300_000 }, 0);
    expect(est.lines.find((l) => l.item === 'standard requests')).toMatchObject({ freeAllowance: 200_000, billable: 100_000 });
  });

  it('charges provisioned DynamoDB capacity by the hour beyond 25 units', () => {
    const est = estimateMonthlyCost({ ...ZERO, provisionedRcu: 30, provisionedWcu: 15 }, 0);
    expect(est.lines.find((l) => l.item === 'provisioned reads')?.billable).toBe(5 * 730);
    expect(est.lines.find((l) => l.item === 'provisioned writes')?.usd).toBe(0);
  });

  it('applies the 400,000 GB-s allowance across architectures, x86 first', () => {
    const est = estimateMonthlyCost({ ...ZERO, gbSecondsX86: 300_000, gbSecondsArm: 200_000 }, 0);
    expect(est.lines.find((l) => l.item === 'compute x86_64')?.billable).toBe(0);
    expect(est.lines.find((l) => l.item === 'compute arm64')?.billable).toBe(100_000);
  });

  it('adds the safety margin', () => {
    const est = estimateMonthlyCost({ ...ZERO, alarms: freeTier.cloudwatchAlarms + 10 }, 20);
    expect(est.subtotalUsd).toBeCloseTo(1);
    expect(est.totalUsd).toBeCloseTo(1.2);
  });

  it('counts Lambda long-poll empty receives as SQS requests', () => {
    expect(sqsRequests({ name: 'q', fifo: true, sent: 10, received: 10, deleted: 10, emptyReceives: 21_600, maxVisible: 0, maxAgeSec: 0 })).toBe(21_630);
  });

  it('projects low ≤ expected ≤ high from measured days', () => {
    const s = projectScenarios([day('2026-11-08', 0.5), day('2026-11-09', 1), day('2026-11-10', 2)]);
    expect(s.low.totalUsd).toBeLessThanOrEqual(s.expected.totalUsd);
    expect(s.expected.totalUsd).toBeLessThanOrEqual(s.high.totalUsd);
    expect(s.expectedUsage.lambdaRequests).toBeCloseTo(((1448 * 0.5 + 1448 + 1448 * 2) / 3) * 30);
    // 21,690 SQS requests/day → ~650k/month: inside 1M, worth watching.
    expect(monthlyFromDays([day('2026-11-10')]).sqsFifoRequests).toBe((30 + 30 + 30 + 21_600) * 30);
  });

  it('rates budget use: ok, warn at 80 %, over at 100 %', () => {
    expect(budgetLevel(1, [0.1, 0.2])).toBe('ok');
    expect(budgetLevel(1, [0.8])).toBe('warn');
    expect(budgetLevel(1, [0.5, 1.01])).toBe('over');
  });
});

describe('cost report', () => {
  const billing = { budget: { name: 'job-hunt', limitUsd: 1, actualUsd: 0, forecastUsd: undefined }, plan: { type: 'FREE', status: 'ACTIVE', creditsUsd: 140, expires: '2027-05-10' }, errors: [] };

  it('says so when nothing is measured yet, without inventing numbers', () => {
    const r = buildCostReport([], billing);
    expect(r.level).toBe('no-data');
    expect(r.text).toContain('No measured days yet');
    expect(r.text).not.toMatch(/Projected month/);
  });

  it('shows the budget actual, projections, free-tier use and timeouts', () => {
    const r = buildCostReport([day('2026-11-09'), day('2026-11-10')], billing);
    expect(r.text).toContain('Budget <b>job-hunt</b>: $1.00/month · actual this month <b>$0.00</b> (AWS)');
    expect(r.text).toContain('$140.00 credits left');
    expect(r.text).toMatch(/Projected month<\/b> \(incl\. 20% margin\): low \$[\d.]+ · <b>expected \$[\d.]+<\/b>/);
    expect(r.text).toContain('Free-tier use');
    expect(r.text).toContain('TIMEOUT');
    expect(r.text.length).toBeLessThanOrEqual(3_950);
    expect(costHealthLine(r)).toMatch(/AWS cost: expected \$[\d.]+\/month \(estimate, 2 day\(s\) measured\)/);
  });

  it('warns when the projection reaches the budget', () => {
    const r = buildCostReport([day('2026-11-10', 400)], billing);
    expect(['warn', 'over']).toContain(r.level);
    expect(r.text).toContain('⚠️');
  });

  it('reports an unreadable budget instead of guessing', () => {
    expect(buildCostReport([], { errors: ['budget: AccessDeniedException'] }).text).toContain('not readable (budget: AccessDeniedException)');
  });
});

describe('usage collector', () => {
  function fakeSources(): UsageSources & { queries: MetricQuery[] } {
    const queries: MetricQuery[] = [];
    return {
      queries,
      metric: vi.fn(async (q: MetricQuery, percentiles: boolean) => {
        queries.push(q);
        if (q.metric === 'Invocations') return { sum: 100 };
        if (q.metric === 'Duration') return { sum: 100 * 2000, avg: 2000, max: 59_950, ...(percentiles ? { p50: 1500, p95: 5000 } : {}) };
        if (q.metric === 'NumberOfEmptyReceives') return { sum: 21_000 };
        if (q.metric === 'InvocationAttemptCount') return { sum: 2000 };
        if (q.metric === 'IncomingBytes') return { sum: 1_000_000 };
        return {};
      }),
      functionConfig: vi.fn(async (name: string) => (name.endsWith('gone') ? undefined : { memoryMb: 512, timeoutSec: 60, arch: 'arm64' as const })),
      table: vi.fn(async () => ({ provisionedRcu: 15, provisionedWcu: 15, storageBytes: 1_000, indexes: ['GSI1', 'GSI2'] })),
      logGroups: vi.fn(async () => [{ name: '/aws/lambda/job-finder-x', storedBytes: 5_000, retentionDays: 14 }]),
      alarmCount: vi.fn(async () => 6),
      dashboardCount: vi.fn(async () => 1),
      appUsage: vi.fn(async () => ({ httpRequests: 12, httpBytes: 3_000, telegramSent: 2, 'req#himalayas.app': 3, 'bytes#himalayas.app': 900 })),
      budget: vi.fn(async () => undefined),
      plan: vi.fn(async () => undefined),
    };
  }

  it('reads one complete UTC day for every function, table index and queue', async () => {
    const src = fakeSources();
    const usage = await collectDay('2026-11-10', { functions: ['job-finder-a', 'job-finder-gone'], queueNames: ['n.fifo', 'dlq.fifo'], tableName: 'jobfinder', logGroupPrefix: '/aws/lambda/job-finder-' }, src);
    expect(src.queries.every((q) => q.startMs === dayStartMs('2026-11-10') && q.endMs === dayStartMs('2026-11-11'))).toBe(true);
    expect(usage.lambda).toHaveLength(1); // a missing function is skipped, not invented
    expect(usage.lambda[0]).toMatchObject({ invocations: 100, durationSumMs: 200_000, p95Ms: 5000, hitTimeout: true });
    expect(usage.sqs.map((q) => q.fifo)).toEqual([true, true]);
    expect(usage.scheduler.attempts).toBe(2000);
    expect(usage.logs[0]).toMatchObject({ ingestedBytes: 1_000_000, storedBytes: 5_000, retentionDays: 14 });
    // 4 Lambda + 12 DynamoDB (table + 2 GSIs) + 12 SQS + 4 Scheduler + 1 Logs metric calls, + 2 Describe/List.
    expect(usage.cloudwatch.apiRequestsByCollector).toBe(4 + 12 + 12 + 4 + 1 + 2);
    expect(usage.app).toMatchObject({ httpRequests: 12, httpBytes: 3_000, telegramSent: 2, byHost: { 'himalayas.app': { requests: 3, bytes: 900 } } });
  });

  it('lists the complete days before now, newest first', () => {
    expect(previousDays(Date.parse('2026-11-11T00:20:00Z'), 3)).toEqual(['2026-11-10', '2026-11-09', '2026-11-08']);
  });

  it('treats missing app counters as zero', () => {
    expect(parseAppUsage(undefined)).toMatchObject({ httpRequests: 0, telegramSent: 0, byHost: {} });
  });
});
