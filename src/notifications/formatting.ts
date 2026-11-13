import { formatSalary } from '../core/salary';
import type { JobItem } from '../data/jobs';
import { relativeAge } from '../lib/time';

/** §11: escape every source-provided string before formatting (HTML parse mode). */
export function escapeHtml(value: string | undefined | null): string {
  return (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function link(url: string | undefined, label: string): string {
  if (!url) return escapeHtml(label);
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return escapeHtml(label);
    return `<a href="${escapeHtml(u.toString())}">${escapeHtml(label)}</a>`;
  } catch {
    return escapeHtml(label);
  }
}

const SKILL_LABELS: Record<string, string> = {
  node: 'Node.js',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  nestjs: 'NestJS',
  express: 'Express',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  redis: 'Redis',
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  aws: 'AWS',
  kafka: 'Kafka',
  rabbitmq: 'RabbitMQ',
  grpc: 'gRPC',
  graphql: 'GraphQL',
};

export function skillLabel(skill: string): string {
  return SKILL_LABELS[skill] ?? skill;
}

/** Source attribution line, linking to the original listing as each source requires. */
export function attribution(job: Pick<JobItem, 'via' | 'sourceUrl' | 'company'>): string {
  return `📍 via ${link(job.sourceUrl, job.via ?? 'source')}`;
}

/** §11 alert format. */
export function formatJobAlert(job: JobItem, nowMs: number): string {
  const lines = [`🎯 <b>${escapeHtml(job.title)}</b> — ${job.score}%`];
  const publishedMs = job.publishedAt ? Date.parse(job.publishedAt) : Number.NaN;
  // '~' marks an approximate posting time (date-only or week/month ages).
  const posted = Number.isFinite(publishedMs) ? `posted ${job.publishedAtReliable ? '' : '~'}${relativeAge(publishedMs, nowMs)} · ` : '';
  lines.push(`🏢 ${escapeHtml(job.company)} · 🌍 ${escapeHtml(job.remoteScope)} · 🕒 ${posted}first seen ${relativeAge(Date.parse(job.discoveredAt), nowMs)}`);
  if (job.skills.length > 0) lines.push(`🧩 ${job.skills.slice(0, 6).map((s) => escapeHtml(skillLabel(s))).join(' · ')}`);
  if (job.experienceLevel || job.seniority) lines.push(`💼 <b>Experience:</b> ${escapeHtml(job.experienceLevel ?? job.seniority)}`);
  if (job.employmentType) lines.push(`📋 <b>Type:</b> ${escapeHtml(job.employmentType)}`);
  if (job.salary) lines.push(`💰 ${escapeHtml(formatSalary(job.salary))} (source: ${escapeHtml(job.salary.origin)})`);
  if (job.matchedSearches && job.matchedSearches.length > 0) {
    lines.push(`🔎 <b>Matches:</b> ${job.matchedSearches.map(escapeHtml).join(' · ')}`);
  }
  lines.push(attribution(job));
  if (job.confidence < 1) lines.push(`<i>confidence ${Math.round(job.confidence * 100)}% — some details unknown</i>`);
  return lines.join('\n');
}

/** Compact one-job line for lists and digests. */
export function formatJobLine(job: JobItem, n: number): string {
  const salary = job.salary ? ` · ${escapeHtml(formatSalary(job.salary))}` : '';
  return `${n}. ${link(job.applyUrl, job.title)} — ${escapeHtml(job.company)} · ${job.score}% · ${escapeHtml(job.remoteScope)}${salary} · <i>${escapeHtml(job.via ?? job.sourceId)}</i>`;
}

/** Telegram's 4096-character message limit, with headroom. */
export const MAX_MESSAGE_CHARS = 3900;

/**
 * Joins whole lines until the limit; never cuts inside a line, so HTML tags stay
 * balanced. Returns the text and how many body lines fit.
 */
export function joinWithinLimit(header: string[], body: string[], limit = MAX_MESSAGE_CHARS): { text: string; included: number } {
  let text = header.join('\n');
  let included = 0;
  for (const line of body) {
    const next = `${text}\n${line}`;
    if (next.length > limit) break;
    text = next;
    included += 1;
  }
  if (included < body.length) text += `\n<i>…and ${body.length - included} more</i>`;
  return { text, included };
}

export function formatJobList(title: string, jobs: JobItem[]): { text: string; included: number } {
  if (jobs.length === 0) return { text: `<b>${escapeHtml(title)}</b>\n\nNothing here yet.`, included: 0 };
  return joinWithinLimit([`<b>${escapeHtml(title)}</b>`, ''], jobs.map((j, i) => formatJobLine(j, i + 1)));
}
