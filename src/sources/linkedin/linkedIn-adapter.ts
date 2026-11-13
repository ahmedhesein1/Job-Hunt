import type { LinkedInSearch } from '../../../config/linkedin-searches';
import { limits } from '../../../config/limits';
import type { ExternalJob } from '../contract';
import { GateClosedError } from '../../scraping/domain-gate';
import { SourceHttpError, type Fetcher } from '../../scraping/fetcher';
import { UnsafeUrlError } from '../../scraping/redirect-guard';
import { ProviderError, type LinkedInSearchProvider, type ProviderErrorKind } from './provider';
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
 * transient errors retried with backoff, and a rate limit, sign-in wall or security check
 * ends the cycle for this provider (see orchestrator.ts).
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
};

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
    // Cards carry no description: skills and experience stay UNKNOWN (lower confidence).
    applyUrl: card.url,
    sourceUrl: card.url,
    publishedAt: card.postedAt,
    publishedAtReliable: card.postedAtPrecise,
    matchedSearches: [search.label],
    via: 'LinkedIn search',
  };
}

/** One guest-endpoint request: the cards from result `start` on (none past the last page). */
async function fetchCards(fetcher: Fetcher, search: LinkedInSearch, start: number, nowMs: number, signal: AbortSignal): Promise<LinkedInCard[]> {
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
  if (result.kind !== 'ok') return [];
  const parsed = parseLinkedInSearchPage(result.value, { capturedAtMs: nowMs });
  if (parsed.status === 'blocked') {
    throw new ProviderError(parsed.reason === 'authwall' ? 'AUTH' : 'BLOCKED', `linkedin: ${parsed.reason === 'authwall' ? 'sign-in page' : 'security check page'} instead of results`);
  }
  // An empty body is LinkedIn's answer for no (more) results.
  return parsed.status === 'ok' ? parsed.cards : [];
}

/** The search-cycle provider backed by the LinkedIn guest results endpoint. */
export function linkedInWebSearchProvider(fetcher: Fetcher, clock: () => number = Date.now): LinkedInSearchProvider {
  let cardsSeen = 0;
  /** Cards per search that LinkedIn returned but the search's filters reject. */
  const filteredOut = new Map<string, number>();
  return {
    id: PROVIDER_ID,
    // Every request targets linkedin.com and the domain gate admits one at a time.
    concurrency: 1,
    async search(search, signal) {
      const jobs = new Map<string, ExternalJob>();
      const seen = new Set<string>();
      let rejected = 0;
      let start = 0;
      try {
        for (let page = 0; page < limits.linkedinSearch.scrapePagesPerSearch && !signal.aborted; page++) {
          const nowMs = clock();
          const cards = await fetchCards(fetcher, search, start, nowMs, signal);
          cardsSeen += cards.length;
          const before = seen.size;
          for (const card of cards) {
            if (seen.has(card.jobId)) continue;
            seen.add(card.jobId);
            if (cardMatchesFilters(card, search, nowMs)) jobs.set(card.jobId, cardToSearchJob(card, search));
            else rejected += 1;
          }
          // Stop at the last page, or when a page repeats cards already seen.
          if (cards.length === 0 || seen.size === before) break;
          start += cards.length;
        }
      } catch (err) {
        throw toLinkedInProviderError(err);
      }
      filteredOut.set(search.id, rejected);
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
  };
}
