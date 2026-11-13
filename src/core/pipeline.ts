import { limits } from '../../config/limits';
import { profiles as defaultProfiles, type SearchProfile } from '../../config/profiles';
import type { SourcePolicy } from '../../config/sources';
import { attachDuplicate, buildJobItem, getJob, insertJob, lookupDedupe, type Delivery } from '../data/jobs';
import { jobNotificationId, outboxPut } from '../data/outbox';
import { instantCapUpdate, type Settings } from '../data/settings';
import { logger } from '../lib/logger';
import { cairoDayKey } from '../lib/time';
import { decideDelivery } from '../notifications/queue';
import type { ExternalJob } from '../sources/contract';
import { fingerprintMatchIsDuplicate, urlHash } from './dedupe';
import { isUsable, normalizeJob, type NormalizedJob } from './normalize';
import { evaluateAll, explainEvaluation, titleShowsNode } from './scoring';
import { parseAtsUrl, type AtsPosting } from './url';

export interface PipelineContext {
  policy: SourcePolicy;
  settings: Settings;
  /** False on the first run of a source: store, but never alert (§8 bootstrap). */
  bootstrapped: boolean;
  /** Skip items published before this (window + watermark overlap). */
  sinceMs: number;
  nowMs: number;
  profiles?: readonly SearchProfile[];
  /** Called once per input job with what happened to it (for per-job replies). */
  onOutcome?: ((outcome: JobOutcome) => void) | undefined;
}

/** Explanation of a job that failed while being stored (e.g. throttling): worth retrying. */
export const PROCESSING_FAILED = 'processing failed';

export interface JobOutcome {
  sourceJobId: string;
  title: string;
  company: string;
  result: 'malformed' | 'out-of-window' | 'rejected' | 'duplicate' | 'stored';
  explanation?: string | undefined;
  score?: number | undefined;
  confidence?: number | undefined;
  delivery?: Delivery | undefined;
}

export interface PipelineStats {
  found: number;
  kept: number;
  stored: number;
  alerts: number;
  digest: number;
  duplicates: number;
  malformed: number;
  rejected: number;
  outOfWindow: number;
  /** Max publishedAt (epoch ms) among processed items, for the watermark. */
  newestPublishedMs?: number | undefined;
  boardCandidates: AtsPosting[];
}

export function emptyStats(): PipelineStats {
  return { found: 0, kept: 0, stored: 0, alerts: 0, digest: 0, duplicates: 0, malformed: 0, rejected: 0, outOfWindow: 0, boardCandidates: [] };
}

type Store = {
  lookupDedupe: typeof lookupDedupe;
  getJob: typeof getJob;
  attachDuplicate: typeof attachDuplicate;
  insertJob: typeof insertJob;
};

const dynamoStore: Store = { lookupDedupe, getJob, attachDuplicate, insertJob };

async function resolveDuplicate(job: NormalizedJob, store: Store): Promise<{ duplicateOf?: string; clusterId: string; useFingerprint: boolean }> {
  const uHash = job.canonicalUrl ? urlHash(job.canonicalUrl) : undefined;
  const found = await store.lookupDedupe(uHash, job.fingerprint);
  if (found.url) return { duplicateOf: found.url.firstJobId, clusterId: found.url.clusterId, useFingerprint: false };
  if (found.fp) {
    const existing = await store.getJob(found.fp.firstJobId);
    // Fingerprint alone is a heuristic: require a second signal (§9).
    if (!existing || fingerprintMatchIsDuplicate(existing, job)) {
      return { duplicateOf: found.fp.firstJobId, clusterId: found.fp.clusterId, useFingerprint: false };
    }
    // Same company/title/scope but evidently a different posting: keep it, without
    // claiming the fingerprint key.
    return { clusterId: job.jobId, useFingerprint: false };
  }
  return { clusterId: job.jobId, useFingerprint: true };
}

/**
 * Shared normalize → eligibility → score → dedupe → transaction pipeline used by every
 * source, company board and the email ingester (§8 steps 9–13, §12).
 */
export async function processJobs(externalJobs: ExternalJob[], ctx: PipelineContext, store: Store = dynamoStore): Promise<PipelineStats> {
  const stats = emptyStats();
  const profiles = ctx.profiles ?? defaultProfiles;
  const evalCtx = { mutedCompanies: ctx.settings.mutedCompanies };
  const primary = profiles[0];
  if (!primary) throw new Error('No search profiles configured');
  const today = cairoDayKey(ctx.nowMs);
  // Reserve instant alerts against a local copy so one run respects the cap too.
  const settings = { ...ctx.settings };

  const report = (external: ExternalJob, outcome: Omit<JobOutcome, 'sourceJobId' | 'title' | 'company'>) =>
    ctx.onOutcome?.({ sourceJobId: external.sourceJobId, title: external.title, company: external.company, ...outcome });

  for (const external of externalJobs) {
    stats.found += 1;
    if (!isUsable(external)) {
      stats.malformed += 1;
      report(external, { result: 'malformed', explanation: 'missing title, ID or URL' });
      continue;
    }
    try {
      const job = normalizeJob(external, primary, ctx.nowMs);
      const publishedMs = job.publishedAt ? Date.parse(job.publishedAt) : undefined;
      if (publishedMs !== undefined) stats.newestPublishedMs = Math.max(stats.newestPublishedMs ?? 0, publishedMs);
      if (publishedMs !== undefined && publishedMs < ctx.sinceMs) {
        stats.outOfWindow += 1;
        report(external, { result: 'out-of-window', explanation: 'posted before the processing window' });
        continue;
      }

      // Board discovery uses the employer URL only — parsed, never fetched (§4.1).
      if (ctx.policy.allowsBoardDiscovery && job.employerUrl) {
        const ats = parseAtsUrl(job.employerUrl);
        if (ats) stats.boardCandidates.push(ats);
      }

      const evaluation = evaluateAll(job, profiles, evalCtx);
      if (evaluation.decision === 'REJECT') {
        stats.rejected += 1;
        report(external, { result: 'rejected', explanation: explainEvaluation(evaluation) });
        continue;
      }
      stats.kept += 1;

      const dup = await resolveDuplicate(job, store);
      if (dup.duplicateOf) {
        if (dup.duplicateOf !== job.jobId) await store.attachDuplicate(dup.duplicateOf, job.sourceId, job.sourceUrl);
        stats.duplicates += 1;
        report(external, { result: 'duplicate', explanation: 'already known from another source or listing' });
        continue;
      }

      let delivery: Delivery = decideDelivery(
        { score: evaluation.score, confidence: evaluation.confidence, publishedAt: job.publishedAt, publishedAtReliable: job.publishedAtReliable, bootstrapped: ctx.bootstrapped },
        settings,
        ctx.nowMs,
      );
      // Without a description the Node must-have cannot be checked: unless the title itself
      // shows Node, the job goes to the digest instead of an instant alert.
      const nodeUnverified = !job.hasDescription && !titleShowsNode(job.title);
      if (delivery === 'INSTANT' && nodeUnverified) delivery = 'DIGEST';

      const attempt = async (d: Delivery) =>
        store.insertJob({
          jobItem: buildJobItem(job, evaluation, d, dup.clusterId, ctx.nowMs),
          jobId: job.jobId,
          clusterId: dup.clusterId,
          urlHash: job.canonicalUrl ? urlHash(job.canonicalUrl) : undefined,
          fpHash: dup.useFingerprint ? job.fingerprint : undefined,
          notificationPut:
            d === 'INSTANT'
              ? outboxPut({ notificationId: jobNotificationId(job.jobId), kind: 'JOB', jobId: job.jobId, clusterId: dup.clusterId, score: evaluation.score }, ctx.nowMs)
              : undefined,
          capUpdate: d === 'INSTANT' ? instantCapUpdate(today, settings) : undefined,
          nowMs: ctx.nowMs,
        });

      let result = await attempt(delivery);
      if (result === 'cap-reached' && delivery === 'INSTANT') {
        // §10.4: overflow goes to the digest, never dropped.
        delivery = 'DIGEST';
        result = await attempt(delivery);
      }
      if (result === 'exists' || result === 'dedupe-race') {
        stats.duplicates += 1;
        report(external, { result: 'duplicate', explanation: 'already stored' });
        continue;
      }
      if (result !== 'created') continue;
      stats.stored += 1;
      if (delivery === 'INSTANT') {
        stats.alerts += 1;
        const sameDay = settings.day === today;
        settings.instantSentToday = (sameDay ? settings.instantSentToday : 0) + 1;
        settings.day = today;
      }
      if (delivery === 'DIGEST') stats.digest += 1;
      report(external, { result: 'stored', explanation: `${explainEvaluation(evaluation)}${nodeUnverified ? ' · Node not verifiable (no description)' : ''}`, score: evaluation.score, confidence: evaluation.confidence, delivery });
    } catch (err) {
      stats.malformed += 1;
      report(external, { result: 'malformed', explanation: PROCESSING_FAILED });
      logger.warn('job processing failed', { sourceId: external.sourceId, sourceJobId: external.sourceJobId, error: err });
    }
  }
  return stats;
}

/** Earliest publish time to process (§8 step 8 and bootstrap). */
export function windowStart(bootstrapped: boolean, watermarkMs: number | undefined, nowMs: number): number {
  if (!bootstrapped || watermarkMs === undefined) return nowMs - limits.sync.bootstrapBackfillDays * 24 * 60 * 60 * 1000;
  return watermarkMs - limits.sync.watermarkOverlapMs;
}
