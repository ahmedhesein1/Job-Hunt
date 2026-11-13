import { limits } from '../../config/limits';
import { linkedinSearches, SEARCH_GROUPS, type SearchGroup } from '../../config/linkedin-searches';
import type { JobOutcome, PipelineStats } from '../core/pipeline';
import { escapeHtml, joinWithinLimit } from '../notifications/formatting';
import { buildLinkedInSearchUrl, validateSearches } from '../sources/linkedin/search-url';
import { importLinkedInSnapshot, type SnapshotImportResult } from '../sources/linkedin/snapshot-import';
import { downloadFile, TelegramError, type InlineKeyboard } from './bot';

/**
 * LinkedIn in Telegram: `/linkedin` gives the saved searches as buttons that open in the
 * owner's browser; a saved results page sent back as an .html file is parsed and run
 * through the normal pipeline.
 */
export interface TelegramDocument {
  file_id: string;
  file_name?: string | undefined;
  mime_type?: string | undefined;
  file_size?: number | undefined;
}

export const SNAPSHOT_HOWTO = [
  '1. Tap a search below — it opens in your browser.',
  '2. Scroll to the bottom of the job list so every card loads.',
  '3. Save the page (Ctrl+S, “Webpage, Complete” or “HTML only”).',
  '4. Send the saved <b>.html</b> file here. Matching jobs alert as usual.',
].join('\n');

function isGroup(value: string): value is SearchGroup {
  return Object.hasOwn(SEARCH_GROUPS, value);
}

/** `/linkedin` lists every saved search; `/linkedin <group>` only that group. */
export function linkedinSearchesReply(arg = ''): { text: string; markup?: InlineKeyboard } {
  validateSearches(linkedinSearches);
  const wanted = arg.trim().toLowerCase();
  const groups = Object.keys(SEARCH_GROUPS) as SearchGroup[];
  if (wanted && !isGroup(wanted)) {
    return { text: `Unknown group. Use /linkedin or one of: ${groups.map((g) => `/linkedin ${g}`).join(', ')}` };
  }
  const selected = linkedinSearches.filter((s) => !wanted || s.group === wanted);
  // Grouped order, ungrouped searches last.
  const ordered = [...groups.flatMap((g) => selected.filter((s) => s.group === g)), ...selected.filter((s) => !s.group)];
  const counts = groups.map((g) => `${SEARCH_GROUPS[g]}: ${linkedinSearches.filter((s) => s.group === g).length}`).join(' · ');
  return {
    text: [
      `🔗 <b>LinkedIn searches</b>${wanted ? ` — ${escapeHtml(SEARCH_GROUPS[wanted as SearchGroup])}` : ''} (${ordered.length})`,
      escapeHtml(counts),
      `<i>Only one group: ${groups.map((g) => `/linkedin ${g}`).join(' · ')}</i>`,
      '',
      SNAPSHOT_HOWTO,
    ].join('\n'),
    markup: { inline_keyboard: ordered.map((s) => [{ text: s.label, url: buildLinkedInSearchUrl(s) }]) },
  };
}

/** Rejects anything that is not a plausible saved HTML page before downloading it. */
export function documentProblem(doc: TelegramDocument): string | undefined {
  const name = (doc.file_name ?? '').toLowerCase();
  const isHtml = /\.html?$/.test(name) || doc.mime_type === 'text/html';
  if (!isHtml) return 'Only saved LinkedIn search pages (.html) are supported. Use /linkedin for the steps.';
  if (doc.file_size !== undefined && doc.file_size > limits.linkedinSnapshot.maxFileBytes) {
    return `That file is larger than ${Math.round(limits.linkedinSnapshot.maxFileBytes / 1024 / 1024)} MB. Save the page as “HTML only” and send it again.`;
  }
  return undefined;
}

export function decodeHtml(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
}

function deliveryLabel(o: JobOutcome): string {
  if (o.delivery === 'INSTANT') return 'alert';
  if (o.delivery === 'DIGEST') return 'digest';
  const n = limits.notifications;
  if (o.score !== undefined && o.score < n.digestMinScore) return 'stored: score below threshold';
  if (o.confidence !== undefined && o.confidence < n.minConfidence) return 'stored: low confidence (no description on the card)';
  return 'stored: posted too long ago to alert';
}

/** Per-job summary: every match with its score and reason, then the rejections. */
export function formatSnapshotReply(result: SnapshotImportResult): string {
  if (result.status !== 'ok') return formatNotImported(result);
  const { stats, outcomes } = result;
  return formatImported(result, stats, outcomes);
}

function formatNotImported(result: Extract<SnapshotImportResult, { status: 'blocked' | 'empty' }>): string {
  if (result.status === 'blocked') {
    return `⛔ That file is a LinkedIn ${escapeHtml(result.reason)}, not search results. Nothing was imported. Open the search in your browser, make sure the results show, then save and send it again.`;
  }
  return `📭 No LinkedIn job cards found (${escapeHtml(result.reason)}). Send a saved jobs <b>search results</b> page; /linkedin has the steps.`;
}

function formatImported(result: Extract<SnapshotImportResult, { status: 'ok' }>, stats: PipelineStats, outcomes: JobOutcome[]): string {
  const stored = outcomes.filter((o) => o.result === 'stored').sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const rejected = outcomes.filter((o) => o.result === 'rejected');
  const header = [
    `📥 <b>LinkedIn page</b>: ${result.cards} job card(s), ${escapeHtml(result.layout)} layout`,
    `🔔 ${stats.alerts} alert(s) · 📰 ${stats.digest} digest · 💾 ${stats.stored - stats.alerts - stats.digest} stored only · ♻️ ${stats.duplicates} already known · ❌ ${stats.rejected} not relevant${stats.outOfWindow ? ` · ⌛ ${stats.outOfWindow} too old` : ''}${stats.malformed ? ` · ⚠️ ${stats.malformed} unreadable` : ''}`,
  ];
  if (result.placeholders > 0) header.push(`⚠️ ${result.placeholders} card(s) had not loaded — scroll to the end of the list before saving.`);
  const body: string[] = [];
  if (stored.length > 0) {
    body.push('', '<b>Matches</b>');
    for (const o of stored) {
      body.push(`• <b>${escapeHtml(o.title)}</b> — ${escapeHtml(o.company)} · ${o.score ?? 0}% (${escapeHtml(deliveryLabel(o))})\n   <i>${escapeHtml(o.explanation)}</i>`);
    }
  }
  if (rejected.length > 0) {
    body.push('', '<b>Not relevant</b>');
    for (const o of rejected) body.push(`• ${escapeHtml(o.title)} — ${escapeHtml(o.company)}: <i>${escapeHtml(o.explanation)}</i>`);
  }
  return joinWithinLimit(header, body).text;
}

export interface SnapshotDeps {
  downloadFile: typeof downloadFile;
  importLinkedInSnapshot: typeof importLinkedInSnapshot;
}

const defaultDeps: SnapshotDeps = { downloadFile, importLinkedInSnapshot };

/** Handles one uploaded document; returns the reply text. */
export async function handleSnapshotDocument(doc: TelegramDocument, sentAtMs: number, nowMs: number, deps: SnapshotDeps = defaultDeps): Promise<string> {
  const problem = documentProblem(doc);
  if (problem) return problem;
  let bytes: Uint8Array;
  try {
    bytes = await deps.downloadFile(doc.file_id, limits.linkedinSnapshot.maxFileBytes);
  } catch (err) {
    if (!(err instanceof TelegramError)) throw err;
    return err.errorCode === 413 ? documentProblem({ ...doc, file_size: Number.MAX_SAFE_INTEGER }) ?? 'File too large.' : 'Could not download that file from Telegram. Please send it again.';
  }
  // The page was saved no later than it was sent: relative ages count from the send time.
  const result = await deps.importLinkedInSnapshot(decodeHtml(bytes), sentAtMs, nowMs);
  return formatSnapshotReply(result);
}
