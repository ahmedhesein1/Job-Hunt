import { randomUUID } from 'node:crypto';
import { limits } from '../../../config/limits';
import { sources } from '../../../config/sources';
import { processJobs, type JobOutcome, type PipelineContext, type PipelineStats } from '../../core/pipeline';
import { getSettings } from '../../data/settings';
import { getSourceState, recordRun, saveSourceState, type RunSummary } from '../../data/sources';
import { logger } from '../../lib/logger';
import { DAY_MS } from '../../lib/time';
import type { ExternalJob, SourceAdapter } from '../contract';
import { parseLinkedInSearchPage, type LinkedInCard, type SnapshotLayout } from './search-page';

const policy = sources['linkedin-snapshot'];

/**
 * Scheduled-run entry for `linkedin-snapshot` in sync-source. Saved pages are imported when
 * the owner uploads them (telegram-webhook → importLinkedInSnapshot), so a scheduled or
 * manual sync-source run has nothing to fetch: it reports why and makes no request.
 */
export const linkedInSnapshotAdapter: SourceAdapter = {
  id: 'linkedin-snapshot',
  fetch: async () => ({ kind: 'skipped', reason: 'imported from uploaded pages (Telegram), not fetched on a schedule' }),
};

/** Maps a parsed card onto the shared source contract. */
export function cardToExternalJob(card: LinkedInCard): ExternalJob {
  return {
    sourceId: 'linkedin-snapshot',
    sourceJobId: card.jobId,
    title: card.title,
    company: card.company,
    location: card.location,
    remote: card.workplace === 'remote' ? true : card.workplace ? false : undefined,
    // Cards carry no description: skills and experience stay UNKNOWN (lower confidence).
    applyUrl: card.url,
    sourceUrl: card.url,
    publishedAt: card.postedAt,
    publishedAtReliable: card.postedAtPrecise,
    via: 'LinkedIn (saved page)',
  };
}

export type SnapshotImportResult =
  | {
      status: 'ok';
      layout: SnapshotLayout;
      cards: number;
      placeholders: number;
      malformed: number;
      stats: PipelineStats;
      outcomes: JobOutcome[];
    }
  | { status: 'blocked' | 'empty'; reason: string };

export interface ImportDeps {
  processJobs: typeof processJobs;
  getSettings: typeof getSettings;
  getSourceState: typeof getSourceState;
  saveSourceState: typeof saveSourceState;
  recordRun: typeof recordRun;
}

const defaultDeps: ImportDeps = { processJobs, getSettings, getSourceState, saveSourceState, recordRun };

/**
 * Parses one saved LinkedIn search page and runs its cards through the shared pipeline.
 * A sign-in wall or security check is recorded as a failed run and nothing else happens:
 * the owner is told.
 */
export async function importLinkedInSnapshot(html: string, capturedAtMs: number, nowMs: number, deps: ImportDeps = defaultDeps): Promise<SnapshotImportResult> {
  const parsed = parseLinkedInSearchPage(html, { capturedAtMs, maxCards: limits.linkedinSnapshot.maxCards });
  const state = await deps.getSourceState(policy.id);
  const runId = randomUUID();
  const startedAt = new Date(nowMs).toISOString();

  if (parsed.status !== 'ok') {
    const reason = parsed.status === 'blocked' ? (parsed.reason === 'authwall' ? 'sign-in page' : 'security check page') : parsed.reason;
    const run: RunSummary = { runId, startedAt, status: 'FAILED', found: 0, kept: 0, alerts: 0, digest: 0, duplicates: 0, malformed: 0, durationMs: Date.now() - nowMs, detail: `${parsed.status}: ${reason}` };
    await deps.saveSourceState(policy.id, { breaker: state.breaker, success: false, changed: false, run }, Date.now());
    await deps.recordRun(policy.id, run, Date.now()).catch((err: unknown) => logger.warn('recordRun failed', { error: err }));
    logger.info('linkedin snapshot not imported', { status: parsed.status, reason });
    return { status: parsed.status, reason };
  }

  const outcomes: JobOutcome[] = [];
  const ctx: PipelineContext = {
    policy,
    settings: await deps.getSettings(),
    // The owner sent this page to be alerted about it: no silent bootstrap run.
    bootstrapped: true,
    sinceMs: nowMs - limits.linkedinSnapshot.maxAgeDays * DAY_MS,
    nowMs,
    onOutcome: (o) => outcomes.push(o),
  };
  const stats = await deps.processJobs(parsed.cards.map(cardToExternalJob), ctx);
  stats.malformed += parsed.malformed;

  const run: RunSummary = {
    runId,
    startedAt,
    status: 'SUCCESS',
    found: stats.found,
    kept: stats.kept,
    alerts: stats.alerts,
    digest: stats.digest,
    duplicates: stats.duplicates,
    malformed: stats.malformed,
    durationMs: Date.now() - nowMs,
    detail: `${parsed.layout} layout, ${parsed.cards.length} card(s), ${parsed.placeholders} unrendered`,
  };
  await deps.saveSourceState(policy.id, { breaker: state.breaker, success: true, changed: stats.stored > 0, run }, Date.now());
  await deps.recordRun(policy.id, run, Date.now()).catch((err: unknown) => logger.warn('recordRun failed', { error: err }));
  logger.info('linkedin snapshot imported', { layout: parsed.layout, cards: parsed.cards.length, placeholders: parsed.placeholders, malformed: parsed.malformed, stored: stats.stored, alerts: stats.alerts });
  return { status: 'ok', layout: parsed.layout, cards: parsed.cards.length, placeholders: parsed.placeholders, malformed: parsed.malformed, stats, outcomes };
}
