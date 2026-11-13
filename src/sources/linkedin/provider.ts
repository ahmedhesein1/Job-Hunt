import type { LinkedInSearch } from "../../../config/linkedin-searches";
import { DynamoDomainGateStore } from "../../data/domains";
import { dynamoSeenStore } from "../../data/seen";
import { DomainGate } from "../../scraping/domain-gate";
import { Fetcher } from "../../scraping/fetcher";
import type { ExternalJob } from "../contract";
import { linkedInWebSearchProvider } from "./linkedIn-adapter";

/**
 * The provider that runs the saved LinkedIn searches. The orchestrator calls it for each
 * search due in a cycle; nothing else in the application depends on how it works. The
 * implementation scrapes LinkedIn's search results (linkedIn-adapter.ts).
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
  /** Items the provider could not read this cycle (a rising share signals a layout change). */
  malformed?(): number | undefined;
  /** Completes new jobs before the pipeline (e.g. with their description), within `signal`. */
  enrich?(newJobs: ExternalJob[], signal: AbortSignal): Promise<EnrichResult>;
}

export interface EnrichResult {
  /** The input jobs, in order, completed where possible. */
  jobs: ExternalJob[];
  fetched: number;
  failed: number;
  /** Why enrichment stopped early (rate limit, block), if it did. */
  stoppedBy?: string | undefined;
}

export type ProviderErrorKind =
  /** Network error or 5xx: retried with backoff within the cycle. */
  | "TRANSIENT"
  /** 429 / quota: stop this provider for the rest of the cycle. */
  | "RATE_LIMITED"
  /** 401/403, revoked key: stop, never retried in the cycle. */
  | "AUTH"
  /** Access refused or a challenge page: stop, never retried or bypassed. */
  | "BLOCKED"
  /** The response was not understood (e.g. the page layout changed): stop, needs review. */
  | "BAD_CONTENT";

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

/**
 * The provider for the 3-minute search cycle: the LinkedIn web search scraper. Its
 * requests share the persisted domain gate, so linkedin.com spacing and breaker state
 * carry across cycles and invocations.
 */
export function linkedinProvider(cycleId: string): LinkedInSearchProvider {
  const fetcher = new Fetcher(
    new DomainGate(new DynamoDomainGateStore(), cycleId),
  );
  return linkedInWebSearchProvider(fetcher, { seen: dynamoSeenStore });
}
