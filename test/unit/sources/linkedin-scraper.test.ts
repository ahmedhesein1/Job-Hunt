import { parse } from 'node-html-parser';
import { describe, expect, it } from 'vitest';
import { linkedinSearches, type LinkedInSearch } from '../../../config/linkedin-searches';
import { limits } from '../../../config/limits';
import { profiles } from '../../../config/profiles';
import { normalizeJob } from '../../../src/core/normalize';
import { DomainGate, InMemoryDomainGateStore } from '../../../src/scraping/domain-gate';
import { Fetcher } from '../../../src/scraping/fetcher';
import { HttpClient, type FetchLike } from '../../../src/scraping/http-client';
import { classifyStatus } from '../../../src/scraping/retry-policy';
import { buildLinkedInJobDetailUrl, parseLinkedInJobDetail } from '../../../src/sources/linkedin/job-detail';
import {
  cardToSearchJob,
  enrichWithJobDetails,
  isEmptyResultsBody,
  linkedInWebSearchProvider,
  PROVIDER_ID,
  toLinkedInProviderError,
} from '../../../src/sources/linkedin/linkedIn-adapter';
import { runSearchCycle, summarize } from '../../../src/sources/linkedin/orchestrator';
import { ProviderError } from '../../../src/sources/linkedin/provider';
import { cardMatchesFilters, type CardFacts } from '../../../src/sources/linkedin/search-match';
import { parseLinkedInSearchPage } from '../../../src/sources/linkedin/search-page';
import { buildLinkedInGuestSearchUrl, InvalidSearchError } from '../../../src/sources/linkedin/search-url';
import { fixtureText } from '../../helpers/fixtures';

const NOW = Date.parse('2026-11-13T21:30:00Z');

/** Real guest-endpoint responses captured 2026-11-13 (tracking parameters and forms removed). */
const GUEST_SEARCH = fixtureText('linkedin-guest-search-2026-11-13.html');
const GUEST_JOB = fixtureText('linkedin-guest-job-2026-11-13.html');
/** LinkedIn's body for "no (more) results", observed 2026-11-13. */
const NO_RESULTS_BODY = '<!DOCTYPE html>\n\n<!---->  ';

/** 42 real cards from a saved results page, served 10 per guest page like the endpoint. */
const REAL_CARDS = parse(fixtureText('linkedin-search-real-2026-11-13.html'))
  .querySelectorAll('.jobs-search__results-list > li')
  .map((li) => li.toString());
const guestPage = (start: number) => REAL_CARDS.slice(start, start + 10).join('\n') || NO_RESULTS_BODY;
const startOf = (url: string) => Number(new URL(url).searchParams.get('start') ?? 0);
const cardUrl = (i: number) => {
  const parsed = parseLinkedInSearchPage(REAL_CARDS[i]!, { capturedAtMs: NOW });
  if (parsed.status !== 'ok') throw new Error('card not parsed');
  return parsed.cards[0]!.url;
};

const html = (body: string, status = 200, headers: Record<string, string> = {}) => {
  // The Response constructor only accepts 200–599; LinkedIn's 999 arrives from the network.
  const res = new Response(body, { status: status > 599 ? 200 : status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
  if (status > 599) Object.defineProperty(res, 'status', { value: status });
  return res;
};

function setup(fetchImpl: FetchLike): Fetcher {
  const clock = { t: NOW };
  const sleeper = async (ms: number) => void (clock.t += ms);
  const gate = new DomainGate(new InMemoryDomainGateStore(), 'cycle-1', { clock: () => clock.t, sleeper, minGapMs: () => 0 });
  const http = new HttpClient({ fetchImpl, resolver: async () => ['93.184.216.34'], userAgent: 'JobFinder/1.0 (test)' });
  return new Fetcher(gate, http, sleeper, () => clock.t);
}

/** In-memory seen store: `known` URLs count as processed in an earlier cycle. */
function seenStore(known: string[] = []) {
  const set = new Set(known);
  const marked: string[] = [];
  return {
    marked,
    unseen: async (urls: string[]) => urls.filter((u) => !set.has(u)),
    markSeen: async (urls: string[]) => {
      for (const u of urls) set.add(u);
      marked.push(...urls);
    },
  };
}

const search: LinkedInSearch = {
  id: 'backend-egypt-24h',
  label: 'Egypt · Backend · 24 h',
  keywords: 'Backend',
  geoId: '106155005',
  datePosted: 'past-week',
  sortByDate: true,
};
const cycle = { concurrency: 4, deadlineMs: Date.now() + 45_000, maxRetries: limits.linkedinSearch.maxRetries, backoffBaseMs: 1 };
const signal = () => AbortSignal.timeout(10_000);

describe('LinkedIn guest URLs', () => {
  it('targets the search endpoint with every filter and the result offset', () => {
    const url = new URL(buildLinkedInGuestSearchUrl({ ...search, datePosted: 'past-24h', workplace: ['remote', 'hybrid'] }, 10));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({ keywords: 'Backend', geoId: '106155005', f_TPR: 'r86400', activeFilter: 'f_TPR', f_WT: '2,3', sortBy: 'DD', start: '10' });
  });

  it('rejects offsets LinkedIn does not serve, invalid searches and invalid job IDs', () => {
    expect(() => buildLinkedInGuestSearchUrl(search, -1)).toThrow(InvalidSearchError);
    expect(() => buildLinkedInGuestSearchUrl(search, 1000)).toThrow(InvalidSearchError);
    expect(() => buildLinkedInGuestSearchUrl({ ...search, keywords: '"open' })).toThrow(InvalidSearchError);
    expect(buildLinkedInJobDetailUrl('4490744228')).toBe('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4490744228');
    expect(() => buildLinkedInJobDetailUrl('../x')).toThrow();
  });

  it('every saved search builds a URL and is sorted newest first (pagination relies on it)', () => {
    for (const s of linkedinSearches) {
      expect(() => buildLinkedInGuestSearchUrl(s)).not.toThrow();
      expect(s.sortByDate).toBe(true);
    }
  });
});

describe('real guest responses (fixtures fail CI when LinkedIn changes its markup) (#5)', () => {
  it('reads every card of a real search response', () => {
    const parsed = parseLinkedInSearchPage(GUEST_SEARCH, { capturedAtMs: NOW });
    expect(parsed).toMatchObject({ status: 'ok', cardsSeen: 10, malformed: 0, placeholders: 0 });
    if (parsed.status !== 'ok') return;
    expect(parsed.cards).toHaveLength(10);
    expect(parsed.cards[0]).toMatchObject({ jobId: '4490744228', title: 'Staff Software Engineer', company: 'OVERJET', location: 'Cairo, Cairo, Egypt', postedText: '5 hours ago', postedAtPrecise: true });
    for (const c of parsed.cards) {
      expect(c.url).toBe(`https://www.linkedin.com/jobs/view/${c.jobId}/`);
      expect(c.location).toMatch(/Egypt/);
    }
  });

  it('reads the description and criteria of a real job page', () => {
    const detail = parseLinkedInJobDetail(GUEST_JOB);
    expect(detail).toBeDefined();
    expect(detail!.descriptionHtml.length).toBeGreaterThan(1_000);
    expect(detail!.descriptionHtml).toContain('Overjet');
    expect(detail).toMatchObject({ employmentType: 'full-time', seniorityHint: undefined }); // "Not Applicable"
  });

  it('a page without a description is not a job page', () => {
    expect(parseLinkedInJobDetail(GUEST_SEARCH)).toBeUndefined();
    expect(parseLinkedInJobDetail('')).toBeUndefined();
  });

  it('recognises the no-results body, and only it, as empty', () => {
    expect(isEmptyResultsBody(NO_RESULTS_BODY)).toBe(true);
    expect(isEmptyResultsBody('')).toBe(true);
    expect(isEmptyResultsBody('<html><body>Something else</body></html>')).toBe(false);
    expect(isEmptyResultsBody(GUEST_SEARCH)).toBe(false);
  });
});

describe('LinkedIn web search provider', () => {
  it('scrapes the cards of a search into jobs for the shared pipeline', async () => {
    const calls: Array<{ url: string; ua: string | null }> = [];
    const provider = linkedInWebSearchProvider(
      setup(async (url, init) => {
        calls.push({ url: String(url), ua: new Headers(init.headers).get('user-agent') });
        return html(GUEST_SEARCH);
      }),
      { clock: () => NOW },
    );
    const jobs = await provider.search(search, signal());
    // Without a seen store nothing tells the search it is caught up: one page.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(buildLinkedInGuestSearchUrl(search, 0));
    expect(calls[0]?.ua).toMatch(/^Mozilla\/5\.0/);
    expect(jobs).toHaveLength(10);
    expect(provider.searched?.()).toBe(10);
    expect(provider.malformed?.()).toBe(0);
    expect(jobs[0]).toMatchObject({
      sourceId: 'linkedin-search',
      sourceJobId: '4490744228',
      title: 'Staff Software Engineer',
      applyUrl: 'https://www.linkedin.com/jobs/view/4490744228/',
      matchedSearches: ['Egypt · Backend · 24 h'],
      publishedAtReliable: true,
      via: 'LinkedIn search',
    });
  });

  describe('pagination until caught up (#2)', () => {
    const paged = () => {
      const starts: number[] = [];
      const fetcher = setup(async (url) => {
        starts.push(startOf(String(url)));
        return html(guestPage(startOf(String(url))));
      });
      return { fetcher, starts };
    };

    it('reads further pages while every card is new, up to the cap', async () => {
      const { fetcher, starts } = paged();
      const jobs = await linkedInWebSearchProvider(fetcher, { seen: seenStore(), clock: () => NOW }).search(search, signal());
      expect(starts).toEqual([0, 10, 20].slice(0, limits.linkedinSearch.scrapeMaxPagesPerSearch));
      expect(jobs).toHaveLength(10 * limits.linkedinSearch.scrapeMaxPagesPerSearch);
    });

    it('stops at the first page holding a job seen in an earlier cycle', async () => {
      const { fetcher, starts } = paged();
      const jobs = await linkedInWebSearchProvider(fetcher, { seen: seenStore([cardUrl(15)]), clock: () => NOW }).search(search, signal());
      expect(starts).toEqual([0, 10]);
      expect(jobs).toHaveLength(20); // the whole page is returned; the pipeline dedupes
    });

    it('a quiet search stays at one request', async () => {
      const { fetcher, starts } = paged();
      await linkedInWebSearchProvider(fetcher, { seen: seenStore([cardUrl(0)]), clock: () => NOW }).search(search, signal());
      expect(starts).toEqual([0]);
    });

    it('stops when LinkedIn has no more results', async () => {
      const starts: number[] = [];
      const fetcher = setup(async (url) => {
        starts.push(startOf(String(url)));
        return html(startOf(String(url)) === 0 ? guestPage(0) : NO_RESULTS_BODY);
      });
      const jobs = await linkedInWebSearchProvider(fetcher, { seen: seenStore(), clock: () => NOW }).search(search, signal());
      expect(starts).toEqual([0, 10]);
      expect(jobs).toHaveLength(10);
    });

    it('remembers cards the filters drop, so they do not look new next cycle', async () => {
      const seen = seenStore();
      const provider = linkedInWebSearchProvider(setup(async () => html(guestPage(0))), { seen, clock: () => NOW });
      // All cards are in Egypt: a Saudi search keeps none of them.
      const saudi: LinkedInSearch = { id: 'saudi', label: 'Saudi', keywords: 'Backend', location: 'Saudi Arabia', easyApplyOnly: true, sortByDate: true };
      expect(await provider.search(saudi, signal())).toEqual([]);
      expect(seen.marked).toHaveLength(10);
      expect(provider.note?.(saudi)).toBe("10 card(s) outside the search's filters dropped; applied by LinkedIn only: Easy Apply");
    });
  });

  describe('"no results" vs "page not understood" (#1)', () => {
    it('LinkedIn\'s no-results body is NO_RESULTS', async () => {
      const provider = linkedInWebSearchProvider(setup(async () => html(NO_RESULTS_BODY)), { clock: () => NOW });
      const result = await runSearchCycle([search], provider, cycle);
      expect(result.outcomes[0]).toMatchObject({ status: 'NO_RESULTS', found: 0 });
    });

    it('a non-empty page without job cards stops the cycle as UNPARSEABLE', async () => {
      let requests = 0;
      const changed = '<!DOCTYPE html><html><body><div class="new-layout"><span>Backend Engineer</span></div></body></html>';
      const provider = linkedInWebSearchProvider(
        setup(async () => {
          requests += 1;
          return html(changed);
        }),
        { clock: () => NOW },
      );
      const result = await runSearchCycle(linkedinSearches.slice(0, 3), provider, cycle);
      expect(result.outcomes.map((o) => o.status)).toEqual(['UNPARSEABLE', 'PROVIDER_STOPPED', 'PROVIDER_STOPPED']);
      expect(result.outcomes[0]?.detail).toMatch(/no recognisable job cards/);
      expect(requests).toBe(1);
    });

    it('counts unreadable cards', async () => {
      // A card with a job ID and text, but no title or company where the parser looks.
      const broken = `${guestPage(0)}\n<li><div data-entity-urn="urn:li:jobPosting:4499999999"><p>Promoted</p></div></li>`;
      const provider = linkedInWebSearchProvider(setup(async () => html(broken)), { clock: () => NOW });
      await provider.search(search, signal());
      expect(provider.malformed?.()).toBe(1);
      expect(provider.searched?.()).toBe(10);
    });
  });

  it('runs saved searches through the cycle, one request at a time', async () => {
    const provider = linkedInWebSearchProvider(setup(async () => html(GUEST_SEARCH)), { clock: () => NOW });
    expect(provider.id).toBe(PROVIDER_ID);
    expect(provider.concurrency).toBe(1);
    const result = await runSearchCycle(linkedinSearches, provider, cycle);
    const counts = summarize(result.outcomes);
    expect((counts.SUCCESS ?? 0) + (counts.NO_RESULTS ?? 0)).toBe(linkedinSearches.length);
    const byId = Object.fromEntries(result.outcomes.map((o) => [o.id, o]));
    expect(byId['backend-egypt-24h']?.status).toBe('SUCCESS');
    // The same 10 Egypt cards for every search: Gulf searches drop them.
    expect(byId['any-backend-saudi']).toMatchObject({ status: 'NO_RESULTS' });
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [999, 'RATE_LIMITED'],
  ])('HTTP %i stops the cycle as %s without retrying', async (status, expected) => {
    let requests = 0;
    const provider = linkedInWebSearchProvider(
      setup(async () => {
        requests += 1;
        return html('', status);
      }),
      { clock: () => NOW },
    );
    const result = await runSearchCycle(linkedinSearches.slice(0, 3), provider, cycle);
    expect(result.outcomes.map((o) => o.status)).toEqual([expected, 'PROVIDER_STOPPED', 'PROVIDER_STOPPED']);
    expect(requests).toBe(1);
  });

  it('reports a sign-in wall as AUTH and a security check as BLOCKED', async () => {
    const authwall = linkedInWebSearchProvider(setup(async () => html(fixtureText('linkedin-authwall.html'))), { clock: () => NOW });
    await expect(authwall.search(search, signal())).rejects.toMatchObject({ kind: 'AUTH' });
    const challenge = linkedInWebSearchProvider(setup(async () => html('<html><head><title>Security Verification | LinkedIn</title></head><body></body></html>')), { clock: () => NOW });
    await expect(challenge.search(search, signal())).rejects.toMatchObject({ kind: 'BLOCKED' });
  });

  it('retries a server error once, then reports the search as FAILED (2 requests in total)', async () => {
    let requests = 0;
    const provider = linkedInWebSearchProvider(
      setup(async () => {
        requests += 1;
        return html('', 502);
      }),
      { clock: () => NOW },
    );
    const result = await runSearchCycle([search], provider, cycle);
    expect(result.outcomes[0]).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(requests).toBe(1 + limits.linkedinSearch.scrapeTransientRetries);
  });

  it('cancels a request in flight at the cycle deadline and reports DEADLINE', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const provider = linkedInWebSearchProvider(setup(hang), { clock: () => NOW });
    const started = Date.now();
    const result = await runSearchCycle([search], provider, { ...cycle, deadlineMs: started + 200 });
    expect(result.outcomes[0]?.status).toBe('DEADLINE');
    // Ended at the deadline, not after the HTTP client's own 18 s timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('marks cards from a remote-only search as remote when the card does not say', () => {
    const card = { jobId: '4400000001', url: 'https://www.linkedin.com/jobs/view/4400000001/', title: 'Backend Engineer', company: 'Acme', location: 'United States', postedAtPrecise: false };
    const remoteOnly: LinkedInSearch = { ...search, workplace: ['remote'] };
    expect(cardToSearchJob(card, remoteOnly).remote).toBe(true);
    expect(cardToSearchJob(card, { ...search, workplace: ['on-site', 'hybrid'] }).remote).toBe(false);
    expect(cardToSearchJob(card, { ...search, workplace: undefined }).remote).toBeUndefined();
    // What the card states wins over the search filter.
    expect(cardToSearchJob({ ...card, workplace: 'hybrid' }, remoteOnly).remote).toBe(false);
  });

  it('maps unexpected errors to TRANSIENT', () => {
    const err = toLinkedInProviderError(new TypeError('boom'));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('TRANSIENT');
  });
});

describe('job descriptions for new jobs (#4)', () => {
  const parsed = parseLinkedInSearchPage(GUEST_SEARCH, { capturedAtMs: NOW });
  if (parsed.status !== 'ok') throw new Error('fixture not parsed');
  const jobs = parsed.cards.map((c) => cardToSearchJob(c, search));
  const detailId = (url: string) => /jobPosting\/(\d+)$/.exec(url)?.[1];

  it('adds the description, then the pipeline judges the job on it', async () => {
    const requested: string[] = [];
    const fetcher = setup(async (url) => {
      requested.push(detailId(String(url))!);
      return html(GUEST_JOB);
    });
    const result = await enrichWithJobDetails(fetcher, jobs.slice(0, 2), signal());
    expect(result).toMatchObject({ fetched: 2, failed: 0 });
    expect(requested.sort()).toEqual([jobs[0]!.sourceJobId, jobs[1]!.sourceJobId].sort());
    const enriched = result.jobs[0]!;
    expect(enriched).toMatchObject({ descriptionIsHtml: true, employmentType: 'full-time', sourceJobId: jobs[0]!.sourceJobId });
    const normalized = normalizeJob(enriched, profiles[0]!, NOW);
    expect(normalized.hasDescription).toBe(true);
    // The description names Python, not Node: the must-have check can now run on it.
    expect(normalized.skills).not.toContain('node');
    expect(normalizeJob(jobs[0]!, profiles[0]!, NOW).hasDescription).toBe(false);
  });

  it('fetches at most detailFetchesPerCycle, newest first', async () => {
    let requests = 0;
    const fetcher = setup(async () => {
      requests += 1;
      return html(GUEST_JOB);
    });
    const result = await enrichWithJobDetails(fetcher, jobs, signal());
    expect(requests).toBe(Math.min(jobs.length, limits.linkedinSearch.detailFetchesPerCycle));
    expect(result.jobs).toHaveLength(jobs.length);
    expect(result.jobs.filter((j) => j.description).length).toBe(requests);
  });

  it('keeps the card when a job page fails or is not a job page', async () => {
    let n = 0;
    const fetcher = setup(async () => (n++ === 0 ? html('', 500) : html('<html><body>Not a job</body></html>')));
    const result = await enrichWithJobDetails(fetcher, jobs.slice(0, 2), signal());
    expect(result).toMatchObject({ fetched: 0, failed: 2 });
    expect(result.jobs).toEqual(jobs.slice(0, 2));
  });

  it('a rate limit stops further detail requests this cycle', async () => {
    let requests = 0;
    const fetcher = setup(async () => {
      requests += 1;
      return html('', 429);
    });
    const result = await enrichWithJobDetails(fetcher, jobs, signal());
    expect(requests).toBe(1);
    expect(result.stoppedBy).toMatch(/RATE_LIMITED/);
    expect(result.jobs).toEqual(jobs);
  });
});

describe('card filters (only what a card states is checked)', () => {
  const card = (over: Partial<CardFacts> = {}): CardFacts => ({ title: 'Backend Engineer', location: 'Cairo, Egypt', postedAt: new Date(NOW - 3_600_000).toISOString(), postedAtPrecise: true, ...over });
  const egyptRemote: LinkedInSearch = { id: 'e', label: 'e', keywords: 'x', location: 'Egypt', geoId: '106155005', workplace: ['remote'], datePosted: 'past-24h' };

  it('checks country, workplace and date when the card states them', () => {
    expect(cardMatchesFilters(card({ workplace: 'remote' }), egyptRemote, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ location: 'Riyadh, Saudi Arabia', workplace: 'remote' }), egyptRemote, NOW)).toBe(false);
    expect(cardMatchesFilters(card({ workplace: 'on-site' }), egyptRemote, NOW)).toBe(false);
    expect(cardMatchesFilters(card({ postedAt: new Date(NOW - 2 * 86_400_000).toISOString() }), egyptRemote, NOW)).toBe(false);
  });

  it('passes what the card does not state', () => {
    // No "(Remote)" marker, no recognisable country, a bare date one day over: LinkedIn decided.
    expect(cardMatchesFilters(card({ workplace: undefined }), egyptRemote, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ location: 'EMEA' }), egyptRemote, NOW)).toBe(true);
    expect(cardMatchesFilters(card({ postedAt: new Date(NOW - 1.5 * 86_400_000).toISOString(), postedAtPrecise: false }), egyptRemote, NOW)).toBe(true);
  });

  it('never rejects by location for worldwide or non-country searches', () => {
    const worldwide = linkedinSearches.filter((s) => s.location === 'Worldwide');
    expect(worldwide.length).toBeGreaterThan(0);
    for (const s of worldwide) expect(cardMatchesFilters(card({ location: 'United States', workplace: s.workplace?.[0], postedAt: undefined }), s, NOW)).toBe(true);
  });
});

describe('LinkedIn status 999', () => {
  it('classifies 999 as a rate limit', () => {
    expect(classifyStatus(999, new Headers(), NOW)).toEqual({ type: 'RATE_LIMITED', retryAfterMs: undefined });
  });
});
