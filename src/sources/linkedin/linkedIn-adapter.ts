import type { LinkedInSearch } from '../../../config/linkedin-searches';
import { limits } from '../../../config/limits';
import type { SeenStore } from '../../data/seen';
import { logger } from '../../lib/logger';
import type { ExternalJob } from '../contract';
import { GateClosedError } from '../../scraping/domain-gate';
import { SourceHttpError, type Fetcher } from '../../scraping/fetcher';
import { UnsafeUrlError } from '../../scraping/redirect-guard';
import { buildLinkedInJobDetailUrl, parseLinkedInJobDetail, withJobDetail } from './job-detail';
import { ProviderError, type EnrichResult, type LinkedInSearchProvider, type ProviderErrorKind } from './provider';
import { cardMatchesFilters, cardUncheckableFilters } from './search-match';
import { parseLinkedInSearchPage, type LinkedInCard } from './search-page';
import { buildLinkedInGuestSearchUrl, LINKEDIN_HOSTS } from './search-url';

/**
 * LinkedIn web search scraper: runs each saved search against LinkedIn's logged-out
 * results endpoint and reads the job cards it returns.
 *
 * The endpoint returns the cards of one results page as HTML `<li>` elements, the same
 * `base-search-card` markup as a logged-out results page, so the saved-page parser
 * (search-page.ts) reads them. All filters of a saved search (date posted, experience,
 * job type, workplace, location/geoId, sort) are sent as URL parameters and applied by
 * LinkedIn. Requests go through the shared Fetcher: one request to linkedin.com at a time,
 * transient errors retried once, and a rate limit, sign-in wall, security check or an
 * unreadable page ends the cycle for this provider (see orchestrator.ts).
 *
 * Results are newest first, so a search reads further pages only while every card on a
 * page is new (not in the seen store), up to `scrapeMaxPagesPerSearch`. New jobs can then
 * be completed with their job page (description, seniority, employment type): `enrich`.
 */
export const PROVIDER_ID = 'linkedin-web-search';

/** Lower-case keys: they replace the HTTP client's defaults instead of being sent alongside. */
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

const KIND_BY_OUTCOME: Partial<Record<string, ProviderErrorKind>> = {
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH: 'AUTH',
  FORBIDDEN: 'BLOCKED',
  CHALLENGE: 'BLOCKED',
  BAD_CONTENT: 'BAD_CONTENT',
};

/** Errors after which no further request to LinkedIn is made this cycle. */
const STOPPING_KINDS: ReadonlySet<ProviderErrorKind> = new Set(['RATE_LIMITED', 'AUTH', 'BLOCKED', 'BAD_CONTENT']);

/** Maps a fetch failure onto the provider error kinds the search cycle acts on. */
export function toLinkedInProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof UnsafeUrlError) return new ProviderError('BLOCKED', `linkedin: request refused (${err.message})`);
  if (err instanceof GateClosedError) {
    // Cooldown: the host breaker is open after rate limits or failures; paused: manual review.
    if (err.reason === 'cooldown') return new ProviderError('RATE_LIMITED', 'linkedin: host cooling down after earlier failures');
    if (err.reason === 'paused') return new ProviderError('BLOCKED', 'linkedin: host paused for manual review');
    return new ProviderError('TRANSIENT', `linkedin: host busy (${err.reason})`);
  }
  if (err instanceof SourceHttpError) {
    const { outcome } = err;
    const status = 'status' in outcome && outcome.status ? ` (HTTP ${outcome.status})` : '';
    return new ProviderError(KIND_BY_OUTCOME[outcome.type] ?? 'TRANSIENT', `linkedin: ${outcome.type}${status}`);
  }
  return new ProviderError('TRANSIENT', `linkedin: ${(err as Error).name}: ${(err as Error).message}`);
}

/**
 * Remote flag for a card: what the card states ("(Remote)" / "(Hybrid)" / "(On-site)"),
 * otherwise the search's own workplace filter when it allows only one kind. Remote-only
 * searches often return cards showing just a country ("United States"), which would
 * otherwise read as on-site there.
 */
function cardIsRemote(card: LinkedInCard, search: LinkedInSearch): boolean | undefined {
  if (card.workplace) return card.workplace === 'remote';
  const workplace = search.workplace ?? [];
  if (workplace.length === 0) return undefined;
  if (workplace.every((w) => w === 'remote')) return true;
  if (!workplace.includes('remote')) return false;
  return undefined;
}

/** Maps a parsed search card onto the shared source contract. */
export function cardToSearchJob(card: LinkedInCard, search: LinkedInSearch): ExternalJob {
  return {
    sourceId: 'linkedin-search',
    sourceJobId: card.jobId,
    title: card.title,
    company: card.company,
    location: card.location,
    remote: cardIsRemote(card, search),
    // No description on a card: `enrich` adds it for new jobs when the budget allows.
    applyUrl: card.url,
    sourceUrl: card.url,
    publishedAt: card.postedAt,
    publishedAtReliable: card.postedAtPrecise,
    matchedSearches: [search.label],
    via: 'LinkedIn search',
  };
}

/**
 * True when a response holds nothing but a doctype, comments and whitespace: LinkedIn's
 * answer for no (more) results (`<!DOCTYPE html>\n\n<!---->`, observed 2026-11-13).
 */
export function isEmptyResultsBody(html: string): boolean {
  return html.replace(/<!doctype[^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim() === '';
}

interface CardsPage {
  cards: LinkedInCard[];
  malformed: number;
}

/** One guest-endpoint request: the cards from result `start` on (none past the last page). */
async function fetchCards(fetcher: Fetcher, search: LinkedInSearch, start: number, nowMs: number, signal: AbortSignal): Promise<CardsPage> {
  const result = await fetcher.fetch(
    {
      url: buildLinkedInGuestSearchUrl(search, start),
      allowedHosts: LINKEDIN_HOSTS,
      expect: 'html',
      maxBytes: limits.linkedinSearch.scrapeMaxPageBytes,
      respectRobots: false,
      headers: HEADERS,
      signal,
      // The only retry layer for a search (the cycle does not retry it again).
      maxRetries: limits.linkedinSearch.scrapeTransientRetries,
    },
    (res) => res.text(),
  );
  if (result.kind !== 'ok' || isEmptyResultsBody(result.value)) return { cards: [], malformed: 0 };
  const parsed = parseLinkedInSearchPage(result.value, { capturedAtMs: nowMs });
  if (parsed.status === 'blocked') {
    throw new ProviderError(parsed.reason === 'authwall' ? 'AUTH' : 'BLOCKED', `linkedin: ${parsed.reason === 'authwall' ? 'sign-in page' : 'security check page'} instead of results`);
  }
  if (parsed.status === 'empty') {
    // A non-empty page without job cards: LinkedIn changed its markup or served another page.
    throw new ProviderError('BAD_CONTENT', `linkedin: results page has no recognisable job cards (${result.value.length} bytes); layout changed?`);
  }
  return { cards: parsed.cards, malformed: parsed.malformed };
}

export interface WebSearchOptions {
  /** Jobs already processed in an earlier cycle; without it, each search reads one page. */
  seen?: Pick<SeenStore, 'unseen' | 'markSeen'> | undefined;
  clock?: () => number;
}

/** The search-cycle provider backed by the LinkedIn guest results endpoint. */
export function linkedInWebSearchProvider(fetcher: Fetcher, options: WebSearchOptions = {}): LinkedInSearchProvider {
  const clock = options.clock ?? Date.now;
  const seen = options.seen;
  let cardsSeen = 0;
  let malformed = 0;
  /** Cards per search that LinkedIn returned but the search's filters reject. */
  const filteredOut = new Map<string, number>();

  /** URLs among `urls` not processed in an earlier cycle; on a store error, assume none are new. */
  const unseen = async (urls: string[]): Promise<string[]> => {
    if (!seen || urls.length === 0) return [];
    try {
      return await seen.unseen(urls);
    } catch (err) {
      logger.warn('linkedin seen lookup failed; not paginating', { error: err });
      return [];
    }
  };

  return {
    id: PROVIDER_ID,
    // Every request targets linkedin.com and the domain gate admits one at a time.
    concurrency: 1,
    async search(search, signal) {
      const jobs = new Map<string, ExternalJob>();
      const read = new Set<string>();
      const dropped: string[] = [];
      let start = 0;
      try {
        for (let page = 0; page < limits.linkedinSearch.scrapeMaxPagesPerSearch && !signal.aborted; page++) {
          const nowMs = clock();
          const result = await fetchCards(fetcher, search, start, nowMs, signal);
          cardsSeen += result.cards.length;
          malformed += result.malformed;
          const before = read.size;
          for (const card of result.cards) {
            if (read.has(card.jobId)) continue;
            read.add(card.jobId);
            if (cardMatchesFilters(card, search, nowMs)) jobs.set(card.jobId, cardToSearchJob(card, search));
            else dropped.push(card.url);
          }
          if (result.cards.length === 0 || read.size === before) break;
          // Newest first: a page holding any job seen in an earlier cycle means the search is caught up.
          if (page + 1 < limits.linkedinSearch.scrapeMaxPagesPerSearch) {
            const urls = result.cards.map((c) => c.url);
            if ((await unseen(urls)).length < urls.length) break;
          }
          start += result.cards.length;
        }
      } catch (err) {
        throw toLinkedInProviderError(err);
      }
      filteredOut.set(search.id, dropped.length);
      // Cards the filters drop never reach the pipeline: remember them so they do not look new.
      if (seen && dropped.length > 0) {
        const fresh = await unseen(dropped);
        if (fresh.length > 0) await seen.markSeen(fresh, clock()).catch((err: unknown) => logger.warn('linkedin markSeen failed', { error: err }));
      }
      return [...jobs.values()];
    },
    note(search) {
      const parts: string[] = [];
      const rejected = filteredOut.get(search.id) ?? 0;
      if (rejected > 0) parts.push(`${rejected} card(s) outside the search's filters dropped`);
      const unchecked = cardUncheckableFilters(search);
      if (unchecked.length > 0) parts.push(`applied by LinkedIn only: ${unchecked.join(', ')}`);
      return parts.length > 0 ? parts.join('; ') : undefined;
    },
    searched: () => cardsSeen,
    malformed: () => malformed,
    async enrich(newJobs, signal) {
      return enrichWithJobDetails(fetcher, newJobs, signal);
    },
  };
}

/**
 * Adds each job's description, seniority and employment type from its LinkedIn job page,
 * newest first, at most `detailFetchesPerCycle` and only until `signal` aborts. A job
 * whose page fails or holds no description keeps its card data. A rate limit, block or
 * unreadable response stops further detail requests this cycle.
 */
export async function enrichWithJobDetails(fetcher: Fetcher, jobs: ExternalJob[], signal: AbortSignal): Promise<EnrichResult> {
  const order = [...jobs].sort((a, b) => Date.parse(b.publishedAt ?? '') - Date.parse(a.publishedAt ?? '') || 0);
  const details = new Map<string, ExternalJob>();
  let fetched = 0;
  let failed = 0;
  let stoppedBy: string | undefined;
  for (const job of order.slice(0, limits.linkedinSearch.detailFetchesPerCycle)) {
    if (signal.aborted) break;
    try {
      const result = await fetcher.fetch(
        {
          url: buildLinkedInJobDetailUrl(job.sourceJobId),
          allowedHosts: LINKEDIN_HOSTS,
          expect: 'html',
          maxBytes: limits.linkedinSearch.scrapeMaxPageBytes,
          respectRobots: false,
          headers: HEADERS,
          signal,
          maxRetries: 0,
        },
        (res) => res.text(),
      );
      const detail = result.kind === 'ok' ? parseLinkedInJobDetail(result.value) : undefined;
      if (detail) {
        details.set(job.sourceJobId, withJobDetail(job, detail));
        fetched += 1;
      } else failed += 1;
    } catch (err) {
      failed += 1;
      if (signal.aborted) break;
      const error = toLinkedInProviderError(err);
      if (STOPPING_KINDS.has(error.kind)) {
        stoppedBy = error.message;
        break;
      }
    }
  }
  return { jobs: jobs.map((j) => details.get(j.sourceJobId) ?? j), fetched, failed, stoppedBy };
}
