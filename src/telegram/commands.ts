import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { limits } from '../../config/limits';
import { sources, type SourceId } from '../../config/sources';
import { companyKey, urlHash } from '../core/dedupe';
import { normalizeForMatch } from '../core/skills';
import { canonicalizeUrl, parseAtsUrl } from '../core/url';
import { addBoard } from '../data/boards';
import { ddb, tableName } from '../data/client';
import { resetDomainGate, DynamoDomainGateStore } from '../data/domains';
import { getJob, lookupDedupe, queryByStatus, transitionStatus, type JobItem } from '../data/jobs';
import { keys, type UserStatus } from '../data/keys';
import { recordMissedReport } from '../data/missed';
import { pendingSummary } from '../data/outbox';
import { getSettings, setCompanyMuted, setPaused } from '../data/settings';
import { getSourceStates, resetSourceBreaker } from '../data/sources';
import { loadDays, loadSnapshot } from '../cost/collect';
import { buildCostReport } from '../cost/report';
import { runDigest } from '../handlers/digest';
import { DAY_MS, iso, relativeAge } from '../lib/time';
import { escapeHtml, formatJobList } from '../notifications/formatting';
import { sqsClient } from '../notifications/queue';
import { resetBreaker } from '../scraping/circuit-breaker';
import { boardApiHost } from '../sources/ats/common';
import type { InlineKeyboard } from './bot';
import { linkedinSearchesReply } from './linkedin';
import { alertKeyboard, DISMISS_REASONS, listKeyboard, reasonKeyboard, statusKeyboard, type ParsedCallback } from './keyboards';

export interface Reply {
  text: string;
  markup?: InlineKeyboard | undefined;
}

export interface CallbackReply {
  toast: string;
  /** New inline keyboard for the message the button belongs to. */
  markup?: InlineKeyboard | undefined;
}

const HELP = [
  '<b>Job Finder</b>',
  '',
  '/top — top 10 new jobs',
  '/saved — saved jobs',
  '/applied — applied / interview / offer',
  '/search &lt;words&gt; — search recent jobs',
  '/status — sources, queues and health',
  '/pause, /resume — pause/resume instant alerts (digest continues)',
  '/resume &lt;source&gt; — clear a manual-review pause after checking the source',
  '/mute &lt;company&gt; — hide a company',
  '/missed &lt;url&gt; — report a missed job or add a Greenhouse/Lever/Ashby board',
  '/linkedin [fresh|egypt|remote] — saved LinkedIn searches; send a saved results page (.html) back to import it',
  '/digest — send the digest now',
  '/cost [refresh] — AWS usage, projected monthly cost and budget',
  '/help — this message',
].join('\n');

function byScore(a: JobItem, b: JobItem): number {
  return b.score - a.score || b.discoveredAt.localeCompare(a.discoveredAt);
}

async function top(): Promise<Reply> {
  const settings = await getSettings();
  const since = iso(Date.now() - limits.top.windowDays * DAY_MS);
  const jobs = (await queryByStatus('New', since, limits.top.maxItemsScanned))
    .filter((j) => !settings.mutedCompanies.has(j.companyKey))
    .sort(byScore)
    .slice(0, limits.top.count);
  const list = formatJobList(`🏆 Top ${jobs.length} new jobs`, jobs);
  return { text: list.text, markup: listKeyboard(jobs.slice(0, list.included)) };
}

async function listStatuses(title: string, statuses: UserStatus[]): Promise<Reply> {
  const jobs: JobItem[] = [];
  for (const status of statuses) jobs.push(...(await queryByStatus(status, '0', 50)));
  jobs.sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt));
  const list = formatJobList(title, jobs.map((j) => ({ ...j, title: `${j.title}${statuses.length > 1 ? ` [${j.userStatus}]` : ''}` })));
  return { text: list.text, markup: listKeyboard(jobs.slice(0, list.included)) };
}

/** §7.2: bounded recent search — date window across status partitions, filtered in code. */
async function search(query: string): Promise<Reply> {
  const words = normalizeForMatch(query).split(' ').filter((w) => w.length > 1);
  if (words.length === 0) return { text: 'Usage: /search &lt;words&gt;' };
  const since = iso(Date.now() - limits.search.windowDays * DAY_MS);
  const statuses: UserStatus[] = ['New', 'Saved', 'Applied', 'Interview', 'Offer'];
  const perStatus = Math.ceil(limits.search.maxItemsScanned / statuses.length);
  const candidates: JobItem[] = [];
  for (const status of statuses) candidates.push(...(await queryByStatus(status, since, perStatus)));
  const matches = candidates
    .filter((j) => {
      const haystack = normalizeForMatch([j.title, j.company, j.remoteScope, j.skills.join(' '), j.summary ?? ''].join(' '));
      return words.every((w) => haystack.includes(w));
    })
    .sort(byScore)
    .slice(0, limits.search.maxResults);
  const list = formatJobList(`🔎 ${matches.length} result(s) for “${query.slice(0, 50)}” (last ${limits.search.windowDays} days)`, matches);
  return { text: list.text, markup: listKeyboard(matches.slice(0, list.included)) };
}

async function queueDepth(envName: string): Promise<number | undefined> {
  const url = process.env[envName];
  if (!url) return undefined;
  const result = await sqsClient().send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }));
  return Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
}

async function status(): Promise<Reply> {
  const now = Date.now();
  const ids = Object.keys(sources) as SourceId[];
  const [states, settings, pending, dlq, streamDlq] = await Promise.all([
    getSourceStates(ids),
    getSettings(),
    pendingSummary(),
    queueDepth('NOTIFICATION_DLQ_URL'),
    queueDepth('STREAM_FAILURE_QUEUE_URL'),
  ]);
  const lines = ['<b>Status</b>', ''];
  for (const state of states) {
    const p = sources[state.sourceId as SourceId];
    if (!p.enabled) {
      lines.push(`⏸ <b>${escapeHtml(p.name)}</b> — disabled: ${escapeHtml(p.disabledReason ?? '')}`);
      continue;
    }
    const lastSuccess = state.lastSuccessAt ? relativeAge(state.lastSuccessAt, now) : 'never';
    const stale = p.staleAfterMinutes !== undefined && (state.lastSuccessAt === undefined || now - state.lastSuccessAt > p.staleAfterMinutes * 60_000);
    const icon = state.breaker.status === 'CLOSED' ? (stale ? '🟡' : '🟢') : state.breaker.status === 'MANUAL_REVIEW' || state.breaker.status === 'UNAVAILABLE' ? '🔴' : '🟠';
    const run = state.lastRun;
    const runInfo = run ? ` · last run ${escapeHtml(run.status)} ${relativeAge(Date.parse(run.startedAt), now)} (found ${run.found}, kept ${run.kept}, alerts ${run.alerts})` : '';
    const runDetail = run && run.status !== 'SUCCESS' && run.detail ? ` — ${escapeHtml(run.detail.slice(0, 160))}` : '';
    const breaker = state.breaker.status !== 'CLOSED' ? ` · ${escapeHtml(state.breaker.status)}${state.breaker.pausedReason ? `: ${escapeHtml(state.breaker.pausedReason)}` : ''}` : '';
    lines.push(`${icon} <b>${escapeHtml(p.name)}</b> — last success ${lastSuccess}${runInfo}${runDetail}${breaker}${stale ? ' · stale' : ''}`);
  }
  lines.push('', `Active boards: ${settings.activeBoards}/${limits.boards.maxActiveBoards}`);
  lines.push(`Instant alerts: ${settings.paused ? 'paused ⏸' : 'on'} · today ${settings.day ? settings.instantSentToday : 0}/${settings.maxInstantAlertsPerDay}`);
  lines.push(`Outbox pending: ${pending.count}${pending.truncated ? '+' : ''}${pending.oldestCreatedAt ? ` (oldest ${relativeAge(Date.parse(pending.oldestCreatedAt), now)})` : ''}`);
  lines.push(`Notification DLQ: ${dlq ?? 'n/a'} · Stream failures: ${streamDlq ?? 'n/a'}`);
  if (settings.mutedCompanies.size > 0) lines.push(`Muted companies: ${settings.mutedCompanies.size}`);
  return { text: lines.join('\n') };
}

/** Clears a manual-review pause on a source and its hosts after human review. */
async function resumeSource(sourceId: string): Promise<Reply> {
  const policy = sources[sourceId as SourceId];
  if (!policy) return { text: `Unknown source. Known: ${Object.keys(sources).join(', ')}` };
  const [state] = await getSourceStates([sourceId]);
  if (state) await resetSourceBreaker(sourceId, resetBreaker(state.breaker));
  const gates = new DynamoDomainGateStore();
  for (const host of policy.allowedHosts) {
    if (await gates.get(host)) await resetDomainGate(host);
  }
  return { text: `▶️ ${escapeHtml(policy.name)} resumed. It will run at its next scheduled time.` };
}

const MISSED_HOSTS: Array<[RegExp, SourceId]> = [
  [/(^|\.)himalayas\.app$/, 'himalayas'],
  [/(^|\.)remoteok\.com$/, 'remoteok'],
  [/(^|\.)jobicy\.com$/, 'jobicy'],
  [/(^|\.)wuzzuf\.net$/, 'wuzzuf'],
  [/(^|\.)linkedin\.com$/, 'linkedin-email'],
  [/^news\.ycombinator\.com$/, 'hn'],
];

/** `/missed <url>`: validated against supported domains; never fetched (§5.2). */
async function missed(rawUrl: string): Promise<Reply> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
    if (url.protocol !== 'https:') throw new Error('not https');
  } catch {
    return { text: 'Please send a valid https:// job URL: /missed &lt;url&gt;' };
  }
  const nowMs = Date.now();
  const ats = parseAtsUrl(url.toString());
  if (ats) {
    const ref = { ats: ats.ats, token: ats.token, region: ats.region };
    const result = await addBoard({ ref, hostname: boardApiHost(ref), addedFrom: 'telegram:/missed', priority: 'normal', intervalMinutes: limits.boards.defaultIntervalMinutes, firstCheckAtMs: nowMs });
    const message =
      result === 'added' ? `➕ Added ${ats.ats} board <b>${escapeHtml(ats.token)}</b>. It will be checked within 5 minutes; its current jobs are stored without alerts.`
      : result === 'exists' ? `${escapeHtml(ats.ats)} board <b>${escapeHtml(ats.token)}</b> is already monitored.`
      : `Active board cap (${limits.boards.maxActiveBoards}) reached; board not added.`;
    return { text: message };
  }
  const source = MISSED_HOSTS.find(([re]) => re.test(url.hostname.toLowerCase()))?.[1];
  if (!source) return { text: 'Unsupported site. Supported: Greenhouse, Lever, Ashby boards, and Himalayas, Remote OK, Jobicy, Wuzzuf, LinkedIn, HN job links.' };
  const canonical = canonicalizeUrl(url.toString()) ?? url.toString();
  const known = await lookupDedupe(urlHash(canonical), 'none');
  const job = known.url ? await getJob(known.url.firstJobId) : undefined;
  await recordMissedReport(source, canonical, Boolean(job), nowMs);
  if (job) return { text: `Already known: <b>${escapeHtml(job.title)}</b> — ${escapeHtml(job.company)} · score ${job.score}% · status ${job.userStatus}.` };
  return { text: `📝 Recorded a missed-job report for ${escapeHtml(sources[source].name)}. It will appear in the weekly report so the matching rules can be tuned.` };
}

export async function handleCommand(text: string): Promise<Reply> {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return { text: HELP };
  const command = (match[1] ?? '').toLowerCase();
  const arg = (match[2] ?? '').trim();
  switch (command) {
    case 'start':
      return { text: `👋 Private job alerts are active for this chat.\n\n${HELP}` };
    case 'help':
      return { text: HELP };
    case 'top':
      return top();
    case 'saved':
      return listStatuses('⭐ Saved jobs', ['Saved']);
    case 'applied':
      return listStatuses('✅ Applied jobs', ['Applied', 'Interview', 'Offer']);
    case 'search':
      return search(arg);
    case 'status':
      return status();
    case 'pause':
      await setPaused(true);
      return { text: '⏸ Instant alerts paused. Jobs are still collected for the digest. /resume to turn them back on.' };
    case 'resume':
      if (arg) return resumeSource(arg.toLowerCase());
      await setPaused(false);
      return { text: '▶️ Instant alerts resumed.' };
    case 'mute': {
      if (!arg) return { text: 'Usage: /mute &lt;company&gt;' };
      const key = companyKey(arg);
      if (!key) return { text: 'Usage: /mute &lt;company&gt;' };
      await setCompanyMuted(key, arg.slice(0, 120), true);
      return { text: `🚫 Muted <b>${escapeHtml(arg.slice(0, 120))}</b>. Its jobs will no longer alert.` };
    }
    case 'missed':
      if (!arg) return { text: 'Usage: /missed &lt;url&gt;' };
      return missed(arg);
    case 'cost':
      return cost(arg);
    case 'linkedin':
      return linkedinSearchesReply(arg);
    case 'digest': {
      const result = await runDigest(Date.now());
      return { text: result.jobs === 0 ? '📭 No jobs waiting for the digest.' : `📬 Digest queued: ${result.jobs} job(s) in ${result.messages} message(s).` };
    }
    default:
      return { text: HELP };
  }
}

const COST_STALE_MS = 26 * 60 * 60 * 1000;
let lambdaClient: LambdaClient | undefined;

/** Starts a background usage collection; its report arrives as a separate message. */
async function requestCostCollection(): Promise<void> {
  const fn = process.env.MAINTENANCE_FUNCTION;
  if (!fn) throw new Error('MAINTENANCE_FUNCTION is not configured');
  lambdaClient ??= new LambdaClient({});
  await lambdaClient.send(new InvokeCommand({ FunctionName: fn, InvocationType: 'Event', Payload: new TextEncoder().encode(JSON.stringify({ task: 'cost', notify: true })) }));
}

/** §9 /cost: stored report instantly; collects in the background when stale or asked. */
async function cost(arg: string): Promise<Reply> {
  const [snapshot, days] = await Promise.all([loadSnapshot(), loadDays()]);
  const stale = !snapshot || Date.now() - Date.parse(snapshot.collectedAt) > COST_STALE_MS;
  if (arg.toLowerCase() === 'refresh' || stale) {
    await requestCostCollection();
    const note = '⏳ Collecting AWS usage now (CloudWatch, DynamoDB, SQS, Scheduler, budget). The report arrives in under a minute.';
    return { text: snapshot && days.length > 0 ? `${buildCostReport(days, snapshot.billing).text}

${note}` : note };
  }
  return { text: buildCostReport(days, snapshot.billing).text };
}

async function markCompanyApplied(job: JobItem, nowMs: number): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.company(job.companyKey),
      UpdateExpression: 'SET appliedAt = :at, #name = if_not_exists(#name, :name), entity = :e',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: { ':at': new Date(nowMs).toISOString(), ':name': job.company, ':e': 'COMPANY' },
    }),
  );
}

const STATUS_FOR: Partial<Record<ParsedCallback['action'], UserStatus>> = {
  save: 'Saved',
  applied: 'Applied',
  interview: 'Interview',
  offer: 'Offer',
};

/** Inline button handler. Every action validates that the job exists in our dataset. */
export async function handleCallback(cb: ParsedCallback): Promise<CallbackReply> {
  const nowMs = Date.now();
  const job = await getJob(cb.jobId);
  if (!job) return { toast: 'This job is no longer available.', markup: { inline_keyboard: [] } };

  const target = STATUS_FOR[cb.action];
  if (target) {
    const result = await transitionStatus(job.jobId, target, nowMs);
    if (!result.ok) return { toast: `Already ${result.current ?? 'updated'}.` };
    if (target === 'Applied') await markCompanyApplied(job, nowMs);
    const labels: Record<string, string> = { Saved: '⭐ Saved', Applied: '✅ Marked as applied', Interview: '🗣 Interview — good luck!', Offer: '🏆 Offer — congratulations!' };
    return { toast: labels[target] ?? target, markup: statusKeyboard(job.jobId, job.applyUrl, target) };
  }
  switch (cb.action) {
    case 'not-relevant':
      return { toast: 'Why is it not relevant?', markup: reasonKeyboard(job.jobId) };
    case 'cancel':
      return { toast: 'Cancelled', markup: alertKeyboard(job.jobId, job.applyUrl) };
    case 'reason': {
      const reason = cb.reason ? DISMISS_REASONS[cb.reason] : 'other';
      const result = await transitionStatus(job.jobId, 'Dismissed', nowMs, reason);
      if (!result.ok) return { toast: `Already ${result.current ?? 'updated'}.` };
      return { toast: `👎 Dismissed (${reason})`, markup: { inline_keyboard: [] } };
    }
    case 'hide-company':
      await setCompanyMuted(job.companyKey, job.company, true);
      return { toast: `🚫 ${job.company} hidden`, markup: { inline_keyboard: [] } };
    default:
      return { toast: 'Unknown action' };
  }
}
