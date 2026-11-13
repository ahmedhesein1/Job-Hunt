import type { LinkedInSearch } from '../../../config/linkedin-searches';
import type { ExternalJob } from '../contract';
import { NO_PROVIDER_REASON, ProviderError, type LinkedInSearchProvider } from './provider';

export type SearchStatus =
  | 'SUCCESS'
  | 'NO_RESULTS'
  | 'RATE_LIMITED'
  | 'BLOCKED'
  | 'AUTH_REQUIRED'
  | 'PROVIDER_UNAVAILABLE'
  | 'FAILED'
  /** Not started: an earlier search stopped the provider for this cycle. */
  | 'PROVIDER_STOPPED'
  /** Not started or abandoned: the cycle deadline was reached. Retried next cycle. */
  | 'DEADLINE';

export interface SearchOutcome {
  id: string;
  status: SearchStatus;
  ms: number;
  attempts: number;
  found?: number | undefined;
  detail?: string | undefined;
}

export interface CycleOptions {
  /** Cycle-wide cap on searches in flight (the provider's own cap also applies). */
  concurrency: number;
  /** Absolute time (epoch ms) after which no search starts or retries. */
  deadlineMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface CycleResult {
  outcomes: SearchOutcome[];
  /** Unique jobs across all searches (a job found by several searches appears once). */
  jobs: ExternalJob[];
  /** Repeated source job IDs removed before the shared pipeline. */
  duplicates: number;
  provider: string | undefined;
  /** Jobs the provider searched this cycle, when it reports it. */
  searched?: number | undefined;
}

const STOPPING: Record<string, SearchStatus> = { BLOCKED: 'BLOCKED', AUTH: 'AUTH_REQUIRED', RATE_LIMITED: 'RATE_LIMITED' };

/**
 * Runs every saved search once: bounded concurrency, bounded retries with exponential
 * backoff and full jitter for transient errors, a global deadline, and an immediate stop
 * for the provider on a block, auth failure or rate limit (never retried or bypassed).
 * Every search gets an outcome; nothing is skipped silently.
 */
export async function runSearchCycle(searches: readonly LinkedInSearch[], provider: LinkedInSearchProvider | undefined, opts: CycleOptions): Promise<CycleResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  if (!provider) {
    return { provider: undefined, jobs: [], duplicates: 0, outcomes: searches.map((s) => ({ id: s.id, status: 'PROVIDER_UNAVAILABLE', ms: 0, attempts: 0, detail: NO_PROVIDER_REASON })) };
  }

  const outcomes = new Array<SearchOutcome>(searches.length);
  const jobs = new Map<string, ExternalJob>();
  let duplicates = 0;
  let stopped: SearchStatus | undefined;
  let next = 0;

  const runOne = async (search: LinkedInSearch): Promise<SearchOutcome> => {
    const started = now();
    let attempts = 0;
    for (;;) {
      if (stopped) return { id: search.id, status: 'PROVIDER_STOPPED', ms: now() - started, attempts, detail: `provider stopped: ${stopped}` };
      const remaining = opts.deadlineMs - now();
      if (remaining <= 0) return { id: search.id, status: 'DEADLINE', ms: now() - started, attempts };
      attempts += 1;
      try {
        const found = await provider.search(search, AbortSignal.timeout(remaining));
        for (const job of found) {
          const key = job.storedJobId ?? `${job.sourceId}#${job.sourceJobId}`;
          const existing = jobs.get(key);
          if (existing) {
            duplicates += 1;
            if (job.matchedSearches) {
              const currentMatches = new Set(existing.matchedSearches ?? []);
              for (const s of job.matchedSearches) currentMatches.add(s);
              existing.matchedSearches = [...currentMatches];
            }
          } else {
            jobs.set(key, { ...job, matchedSearches: job.matchedSearches ? [...job.matchedSearches] : undefined });
          }
        }
        return { id: search.id, status: found.length ? 'SUCCESS' : 'NO_RESULTS', ms: now() - started, attempts, found: found.length, detail: provider.note?.(search) };
      } catch (err) {
        const kind = err instanceof ProviderError ? err.kind : 'TRANSIENT';
        const detail = (err as Error).message.slice(0, 200);
        const stop = STOPPING[kind];
        if (stop) {
          stopped ??= stop;
          return { id: search.id, status: stop, ms: now() - started, attempts, detail };
        }
        if (attempts > opts.maxRetries) return { id: search.id, status: 'FAILED', ms: now() - started, attempts, detail };
        // Full jitter: random delay up to base × 2^(attempt-1), never past the deadline.
        const backoff = random() * opts.backoffBaseMs * 2 ** (attempts - 1);
        if (now() + backoff >= opts.deadlineMs) return { id: search.id, status: 'DEADLINE', ms: now() - started, attempts, detail };
        await sleep(backoff);
      }
    }
  };

  const workers = Math.max(1, Math.min(opts.concurrency, provider.concurrency, searches.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let i = next++; i < searches.length; i = next++) outcomes[i] = await runOne(searches[i]!);
    }),
  );
  return {
    provider: provider.id,
    outcomes,
    jobs: [...jobs.values()],
    duplicates,
    searched: provider.searched?.(),
  };
}

/** Counts per status, for run records and /status. */
export function summarize(outcomes: readonly SearchOutcome[]): Partial<Record<SearchStatus, number>> {
  const out: Partial<Record<SearchStatus, number>> = {};
  for (const o of outcomes) out[o.status] = (out[o.status] ?? 0) + 1;
  return out;
}
