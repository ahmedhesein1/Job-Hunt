import { limits } from '../../config/limits';
import { queryByStatus, type JobItem } from '../data/jobs';
import type { UserStatus } from '../data/keys';
import { putFriendText } from '../data/outbox';
import type { Settings } from '../data/settings';
import { cairoDayKey, DAY_MS, iso } from '../lib/time';
import { escapeHtml, formatJobLine, MAX_MESSAGE_CHARS } from './formatting';

/**
 * Catch-up for a friend added with /friends: they only receive alerts from then on, so
 * they first get the best recent jobs. The owner's dismissals and muted companies are
 * respected; jobs the owner saved or applied to are still good for the friend.
 */
const SHARED_STATUSES: UserStatus[] = ['New', 'Saved', 'Applied', 'Interview', 'Offer'];

/** The jobs a new friend should see: recent, alert-worthy, best score first. */
export function catchUpJobs(jobs: readonly JobItem[], settings: Pick<Settings, 'mutedCompanies'>, nowMs: number): JobItem[] {
  const n = limits.notifications;
  const since = nowMs - n.friendCatchUpDays * DAY_MS;
  const unique = new Map(jobs.map((j) => [j.jobId, j]));
  return [...unique.values()]
    .filter((j) => Date.parse(j.discoveredAt) >= since)
    .filter((j) => j.score >= n.digestMinScore && j.confidence >= n.minConfidence)
    .filter((j) => !settings.mutedCompanies.has(j.companyKey))
    .sort((a, b) => b.score - a.score || b.discoveredAt.localeCompare(a.discoveredAt))
    .slice(0, n.friendCatchUpMaxJobs);
}

/** Splits the list into Telegram-sized messages without cutting a line. */
export function catchUpMessages(jobs: readonly JobItem[]): string[] {
  const header = (part: number, parts: number) =>
    `📚 <b>Recent jobs</b>${parts > 1 ? ` (${part}/${parts})` : ''} — best ${jobs.length} of the last ${limits.notifications.friendCatchUpDays} days`;
  const lines = jobs.map((j, i) => formatJobLine(j, i + 1));
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = header(99, 99).length + 2;
  for (const line of lines) {
    if (current.length > 0 && length + line.length + 1 > MAX_MESSAGE_CHARS) {
      chunks.push(current);
      current = [];
      length = header(99, 99).length + 2;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((chunk, i) => [header(i + 1, chunks.length), '', ...chunk].join('\n'));
}

/**
 * Queues the catch-up for `chatId`. At most once per friend per Cairo day (adding the same
 * friend again that day sends nothing new). Returns the number of jobs sent.
 */
export async function queueFriendCatchUp(chatId: string, settings: Pick<Settings, 'mutedCompanies'>, nowMs: number): Promise<number> {
  const since = iso(nowMs - limits.notifications.friendCatchUpDays * DAY_MS);
  const perStatus = await Promise.all(SHARED_STATUSES.map((s) => queryByStatus(s, since, limits.top.maxItemsScanned)));
  const jobs = catchUpJobs(perStatus.flat(), settings, nowMs);
  const day = cairoDayKey(nowMs);
  const welcome = `👋 You will now get new ${escapeHtml('Node.js / backend')} job alerts here as soon as they are found, plus a digest at 09:00 and 18:00 Cairo time.`;
  const messages = jobs.length > 0 ? [welcome, ...catchUpMessages(jobs)] : [welcome];
  for (const [i, text] of messages.entries()) await putFriendText(`catchup:${chatId}:${day}:${i}`, chatId, text, nowMs);
  return jobs.length;
}
