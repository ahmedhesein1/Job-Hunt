import { costSettings, freeTier, PRICING_AS_OF } from '../../config/pricing';
import { escapeHtml, joinWithinLimit } from '../notifications/formatting';
import { budgetLevel, gbSeconds, projectScenarios, sqsRequests, type Scenarios } from './estimate';
import type { BillingFacts, DailyUsage } from './types';

const usd = (v: number) => (v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const n = (v: number) => Math.round(v).toLocaleString('en-US');
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '—');
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const ms = (v: number | undefined) => (v === undefined ? '—' : `${Math.round(v)} ms`);

export interface CostReport {
  text: string;
  level: 'ok' | 'warn' | 'over' | 'no-data';
  scenarios?: Scenarios | undefined;
}

function avgPerDay(days: DailyUsage[], f: (d: DailyUsage) => number): number {
  return days.reduce((s, d) => s + f(d), 0) / days.length;
}

/** §9 report: measured usage, free-tier headroom, projections and the budget. */
export function buildCostReport(days: DailyUsage[], billing: BillingFacts): CostReport {
  const header = ['💰 <b>AWS usage &amp; cost</b> — eu-north-1', '<i>Projections are estimates from measured usage; the bill is the budget "actual" figure.</i>', ''];
  const b = billing.budget;
  const budgetLine = b
    ? `🎯 Budget <b>${escapeHtml(b.name)}</b>: ${usd(b.limitUsd)}/month · actual this month <b>${usd(b.actualUsd)}</b> (AWS)${b.forecastUsd !== undefined ? ` · AWS forecast ${usd(b.forecastUsd)}` : ''}`
    : `🎯 Budget: not readable${billing.errors.length ? ` (${escapeHtml(billing.errors.join('; '))})` : ''}`;
  const planLine = billing.plan
    ? `🎁 AWS ${escapeHtml(billing.plan.type)} plan (${escapeHtml(billing.plan.status)})${billing.plan.creditsUsd !== undefined ? ` · ${usd(billing.plan.creditsUsd)} credits left` : ''}${billing.plan.expires ? ` · until ${escapeHtml(billing.plan.expires)}` : ''}`
    : undefined;

  if (days.length === 0) {
    return { level: 'no-data', text: [...header, budgetLine, ...(planLine ? [planLine] : []), '', 'No measured days yet. The first collection runs within minutes of deployment.'].join('\n') };
  }

  const sorted = [...days].sort((a, z) => a.day.localeCompare(z.day));
  const s = projectScenarios(sorted);
  const limit = b?.limitUsd;
  const level = limit !== undefined ? budgetLevel(limit, [s.expected.totalUsd, b?.actualUsd ?? 0, b?.forecastUsd ?? 0]) : 'ok';
  const icon = level === 'over' ? '🔴' : level === 'warn' ? '🟠' : '🟢';
  const m = s.expectedUsage;

  const lines: string[] = [
    budgetLine,
    ...(planLine ? [planLine] : []),
    `📅 Measured ${sorted.length} day(s): ${sorted[0]!.day} → ${sorted[sorted.length - 1]!.day} (UTC) · prices as of ${PRICING_AS_OF}`,
    '',
    `${icon} <b>Projected month</b> (incl. ${s.expected.marginPct}% margin): low ${usd(s.low.totalUsd)} · <b>expected ${usd(s.expected.totalUsd)}</b> · high ${usd(s.high.totalUsd)}${limit ? ` — ${pct(s.expected.totalUsd, limit)} of budget` : ''}`,
  ];
  if (level !== 'ok') lines.push(`⚠️ Projected or actual cost is at or above ${costSettings.warnAtBudgetPct}% of the budget.`);

  const paid = s.expected.lines.filter((l) => l.usd > 0).sort((a, z) => z.usd - a.usd);
  if (paid.length > 0) {
    lines.push('', '<b>Paid items (expected)</b>');
    for (const l of paid.slice(0, 6)) lines.push(`• ${escapeHtml(l.service)} ${escapeHtml(l.item)}: ${n(l.billable)} ${escapeHtml(l.unit)} over free → ${usd(l.usd)}`);
  }

  lines.push('', '<b>Free-tier use (projected month)</b>');
  lines.push(`• Lambda: ${n(m.lambdaRequests)} requests (${pct(m.lambdaRequests, freeTier.lambdaRequests)}) · ${n(m.gbSecondsArm + m.gbSecondsX86)} GB-s (${pct(m.gbSecondsArm + m.gbSecondsX86, freeTier.lambdaGbSeconds)})`);
  lines.push(`• DynamoDB: ${n(m.provisionedRcu)} RCU / ${n(m.provisionedWcu)} WCU provisioned (of ${freeTier.dynamodbRcu}/${freeTier.dynamodbWcu}) · ${(m.dynamoStorageGb * 1024).toFixed(1)} MB stored`);
  lines.push(`• SQS: ${n(m.sqsFifoRequests + m.sqsStandardRequests)} requests (${pct(m.sqsFifoRequests + m.sqsStandardRequests, freeTier.sqsRequests)})`);
  lines.push(`• Scheduler: ${n(m.schedulerInvocations)} invocations (${pct(m.schedulerInvocations, freeTier.schedulerInvocations)})`);
  lines.push(`• Logs: ${(m.logIngestGb * 1024).toFixed(0)} MB ingested + ${(m.logStoredGb * 1024).toFixed(0)} MB stored (${pct(m.logIngestGb + m.logStoredGb, freeTier.cloudwatchLogsGb)} of 5 GB)`);
  lines.push(`• CloudWatch: ${m.alarms} alarms (of ${freeTier.cloudwatchAlarms}) · ${m.dashboards} dashboards (of ${freeTier.cloudwatchDashboards}) · ${n(m.cloudwatchApiRequests)} API calls`);

  // Per-day measured detail.
  const latest = sorted[sorted.length - 1]!;
  const lambdaByCost = [...latest.lambda].sort((a, z) => gbSeconds(z.durationSumMs, z.memoryMb) - gbSeconds(a.durationSumMs, a.memoryMb));
  lines.push('', `<b>Lambda on ${latest.day}</b> (invocations · p50/p95/max · GB-s)`);
  for (const l of lambdaByCost.filter((x) => x.invocations > 0).slice(0, 8)) {
    const prefix = process.env.STACK_NAME ? `${process.env.STACK_NAME}-` : '';
    const short = prefix && l.name.startsWith(prefix) ? l.name.slice(prefix.length) : l.name;
    const flags = [l.errors ? `${n(l.errors)} err` : '', l.throttles ? `${n(l.throttles)} throttled` : '', l.hitTimeout ? 'TIMEOUT' : ''].filter(Boolean).join(', ');
    lines.push(`• ${escapeHtml(short)} ${l.memoryMb} MB ${l.arch}: ${n(l.invocations)} · ${ms(l.p50Ms)}/${ms(l.p95Ms)}/${ms(l.maxMs)} · ${gbSeconds(l.durationSumMs, l.memoryMb).toFixed(0)}${flags ? ` · ⚠️ ${flags}` : ''}`);
  }

  const ddbAvg = (f: (d: DailyUsage) => number) => n(avgPerDay(sorted, f));
  lines.push('', '<b>Average per day</b>');
  lines.push(`• DynamoDB consumed: ${ddbAvg((d) => d.dynamodb.consumedRcu)} RCU · ${ddbAvg((d) => d.dynamodb.consumedWcu)} WCU · throttles ${ddbAvg((d) => d.dynamodb.readThrottles + d.dynamodb.writeThrottles)}`);
  lines.push(`• SQS: ${ddbAvg((d) => d.sqs.reduce((t, q) => t + q.sent, 0))} sent · ${ddbAvg((d) => d.sqs.reduce((t, q) => t + q.emptyReceives, 0))} empty receives · ${ddbAvg((d) => d.sqs.reduce((t, q) => t + sqsRequests(q), 0))} API requests · max age ${Math.max(...sorted.flatMap((d) => d.sqs.map((q) => q.maxAgeSec)), 0)} s`);
  lines.push(`• Scheduler: ${ddbAvg((d) => d.scheduler.attempts)} attempts · ${ddbAvg((d) => d.scheduler.targetErrors)} target errors · ${ddbAvg((d) => d.scheduler.dropped)} dropped`);
  lines.push(`• HTTP out: ${ddbAvg((d) => d.app.httpRequests)} requests · ${mb(avgPerDay(sorted, (d) => d.app.httpBytes))} downloaded · ${ddbAvg((d) => d.app.httpErrors)} network errors`);
  lines.push(`• Telegram: ${ddbAvg((d) => d.app.telegramSent)} sent · ${ddbAvg((d) => d.app.telegramFailed)} failed · ${ddbAvg((d) => d.app.telegramRateLimited)} rate-limited`);
  const retention = [...new Set(latest.logs.map((g) => g.retentionDays ?? 0))].map((r) => (r === 0 ? 'never expires' : `${r} d`)).join(', ');
  lines.push(`• Logs: ${mb(avgPerDay(sorted, (d) => d.logs.reduce((t, g) => t + g.ingestedBytes, 0)))} ingested · retention ${escapeHtml(retention || '—')}`);

  return { level, scenarios: s, text: joinWithinLimit(header, lines).text };
}

/** One line for the daily health message. */
export function costHealthLine(report: CostReport): string | undefined {
  if (!report.scenarios) return undefined;
  const icon = report.level === 'over' ? '🔴' : report.level === 'warn' ? '🟠' : '🟢';
  return `${icon} AWS cost: expected ${usd(report.scenarios.expected.totalUsd)}/month (estimate, ${report.scenarios.days} day(s) measured) — /cost for details`;
}
