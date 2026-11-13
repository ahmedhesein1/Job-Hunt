import type { LinkedInSearch } from "../../../config/linkedin-searches";
import type { SourceId } from "../../../config/sources";
import { queryByStatus } from "../../data/jobs";
import type { ExternalJob, RawSalary } from "../contract";
import {
  isRemoteScope,
  matchesSearch,
  uncheckedFilters,
  type LinkedInCandidate,
} from "./search-match";
import { DynamoDomainGateStore } from "../../data/domains";
import { DomainGate } from "../../scraping/domain-gate";
import { Fetcher } from "../../scraping/fetcher";
import { linkedInWebSearchProvider } from "./linkedIn-adapter";

/**
 * Providers that run the saved searches. The orchestrator calls one for each search every
 * cycle; nothing else in the application depends on how it works.
 *
 * The primary provider scrapes LinkedIn's search results (linkedIn-adapter.ts); its jobs
 * go through the shared pipeline as new jobs. `storedJobsProvider` runs the same searches
 * over jobs other collectors already stored, without web requests.
 */
export interface LinkedInSearchProvider {
  /** Short name shown in /status and run records. */
  id: string;
  /** Max searches in flight at once for this provider (its rate limit). */
  concurrency: number;
  search(search: LinkedInSearch, signal: AbortSignal): Promise<ExternalJob[]>;
  /** Caveat recorded on a search's outcome, e.g. filters the provider cannot apply. */
  note?(search: LinkedInSearch): string | undefined;
  /** Number of jobs the provider searched this cycle (for run records). */
  searched?(): number | undefined;
}

export type ProviderErrorKind =
  /** Network error or 5xx: retried with backoff within the cycle. */
  | "TRANSIENT"
  /** 429 / quota: stop this provider for the rest of the cycle. */
  | "RATE_LIMITED"
  /** 401/403, revoked key: stop, never retried in the cycle. */
  | "AUTH"
  /** Access refused or a challenge page: stop, never retried or bypassed. */
  | "BLOCKED";

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export const NO_PROVIDER_REASON = "no search provider configured";

/** Upper bound on jobs read per cycle (a 3-minute window normally holds a handful). */
const MAX_CANDIDATES = 300;

export interface ProviderContext {
  /** Jobs stored from this time on are searched (previous cycle start minus overlap). */
  sinceMs: number;
  nowMs: number;
}

export interface CandidateStore {
  /** Jobs stored since `sinceIso` by any collector, newest first. */
  recentJobs(sinceIso: string, max: number): Promise<LinkedInCandidate[]>;
}

export const dynamoCandidateStore: CandidateStore = {
  async recentJobs(sinceIso, max) {
    // Every new job enters status "New"; the status index is ordered by discovery time,
    // so this reads only the window, never the whole table.
    return queryByStatus("New", sinceIso, max);
  },
};

/** A stored job that matched a search, keeping its real source and stored identity. */
export function candidateToJob(
  c: LinkedInCandidate,
  search: LinkedInSearch,
): ExternalJob {
  return {
    sourceId: c.sourceId as SourceId,
    sourceJobId: c.sourceJobId ?? c.jobId ?? c.sourceUrl,
    storedJobId: c.jobId,
    title: c.title,
    company: c.company,
    location: c.remoteScope,
    remote: isRemoteScope(c.remoteScope) ? true : undefined,
    description: c.summary,
    applyUrl: c.applyUrl,
    sourceUrl: c.sourceUrl,
    publishedAt: c.publishedAt,
    matchedSearches: [search.label],
    employmentType: c.employmentType,
    seniorityHints: c.seniority ? [c.seniority] : undefined,
    salary: c.salary as RawSalary | undefined,
  };
}

/**
 * Runs each saved search over the jobs stored since the previous cycle. The window is
 * loaded once per cycle and shared by all searches; nothing is fetched from the web.
 */
export function storedJobsProvider(
  ctx: ProviderContext,
  store: CandidateStore,
): LinkedInSearchProvider {
  let candidates: Promise<LinkedInCandidate[]> | undefined;
  let count: number | undefined;
  const load = () => {
    candidates ??= store
      .recentJobs(new Date(ctx.sinceMs).toISOString(), MAX_CANDIDATES)
      .then(
        (list) => {
          count = list.length;
          return list;
        },
        (err: unknown) => {
          candidates = undefined; // let a retry reload
          throw new ProviderError(
            "TRANSIENT",
            `job store: ${(err as Error).message}`,
          );
        },
      );
    return candidates;
  };
  return {
    id: "stored-jobs (all collectors; no web requests)",
    concurrency: 8,
    async search(search) {
      const all = await load();
      return all
        .filter((c) => matchesSearch(c, search, ctx.nowMs))
        .map((c) => candidateToJob(c, search));
    },
    note(search) {
      const unchecked = uncheckedFilters(search);
      return unchecked.length > 0
        ? `not checkable from stored data: ${unchecked.join(", ")}`
        : undefined;
    },
    searched: () => count,
  };
}

/**
 * The provider for the 3-minute search cycle: the LinkedIn web search scraper. Its
 * requests share the persisted domain gate, so linkedin.com spacing and breaker state
 * carry across cycles and invocations.
 */
export function linkedinProvider(
  _ctx: ProviderContext,
  cycleId: string,
): LinkedInSearchProvider {
  const fetcher = new Fetcher(
    new DomainGate(new DynamoDomainGateStore(), cycleId),
  );
  return linkedInWebSearchProvider(fetcher);
}
