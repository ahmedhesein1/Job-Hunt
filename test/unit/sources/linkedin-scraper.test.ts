import { parse } from 'node-html-parser';
import { describe, expect, it } from 'vitest';
import { linkedinSearches, type LinkedInSearch } from '../../../config/linkedin-searches';
import { limits } from '../../../config/limits';
import { rotatedSearches } from '../../../src/handlers/linkedin-orchestrator';
import { DomainGate, InMemoryDomainGateStore } from '../../../src/scraping/domain-gate';
import { Fetcher } from '../../../src/scraping/fetcher';
import { HttpClient, type FetchLike } from '../../../src/scraping/http-client';
import { classifyStatus } from '../../../src/scraping/retry-policy';
import { cardToSearchJob, linkedInWebSearchProvider, PROVIDER_ID, toLinkedInProviderError } from '../../../src/sources/linkedin/linkedIn-adapter';
import { runSearchCycle, summarize } from '../../../src/sources/linkedin/orchestrator';
import { ProviderError } from '../../../src/sources/linkedin/provider';
import { cardMatchesFilters, type CardFacts } from '../../../src/sources/linkedin/search-match';
import { buildLinkedInGuestSearchUrl, InvalidSearchError } from '../../../src/sources/linkedin/search-url';
import { fixtureText } from '../../helpers/fixtures';

const NOW = Date.parse('2026-11-13T18:10:00Z');

/** The guest endpoint's response shape: bare `<li>` cards, taken from a real results page. */
const GUEST_PAGE = parse(fixtureText('linkedin-search-real-2026-11-13.html'))
  .querySelectorAll('.jobs-search__results-list > li')
  .map((li) => li.toString())
  .join('\n');

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

const search: LinkedInSearch = {
  id: 'backend-egypt-24h',
  label: 'Egypt · Backend · 24 h',
  keywords: 'Backend',
  geoId: '106155005',
  datePosted: 'past-24h',
  workplace: ['remote', 'hybrid'],
  sortByDate: true,
};
const cycle = { concurrency: 4, deadlineMs: Date.now() + 45_000, maxRetries: limits.linkedinSearch.maxRetries, backoffBaseMs: 1 };

describe('LinkedIn guest search URL', () => {
  it('targets the guest endpoint with every filter and the result offset', () => {
    const url = new URL(buildLinkedInGuestSearchUrl(search, 10));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      keywords: 'Backend',
      geoId: '106155005',
      f_TPR: 'r86400',
      activeFilter: 'f_TPR',
      f_WT: '2,3',
      sortBy: 'DD',
      start: '10',
    });
  });

  it('rejects offsets LinkedIn does not serve and invalid searches', () => {
    expect(() => buildLinkedInGuestSearchUrl(search, -1)).toThrow(InvalidSearchError);
    expect(() => buildLinkedInGuestSearchUrl(search, 1000)).toThrow(InvalidSearchError);
    expect(() => buildLinkedInGuestSearchUrl({ ...search, keywords: '"open' })).toThrow(InvalidSearchError);
  });

  it('builds a valid URL for every saved search', () => {
    for (const s of linkedinSearches) expect(() => buildLinkedInGuestSearchUrl(s)).not.toThrow();
  });
});

describe('LinkedIn web search provider', () => {
  it('scrapes the cards of a search into jobs for the shared pipeline', async () => {
    const calls: Array<{ url: string; ua: string | null }> = [];
    const fetcher = setup(async (url, init) => {
      calls.push({ url: String(url), ua: new Headers(init.headers).get('user-agent') });
      return html(GUEST_PAGE);
    });
    const provider = linkedInWebSearchProvider(fetcher, () => NOW);
    const jobs = await provider.search(search, AbortSignal.timeout(10_000));

    expect(calls).toHaveLength(limits.linkedinSearch.scrapePagesPerSearch);
    expect(calls[0]?.url).toBe(buildLinkedInGuestSearchUrl(search, 0));
    expect(calls[0]?.ua).toMatch(/^Mozilla\/5\.0/);
    expect(jobs).toHaveLength(42);
    expect(provider.searched?.()).toBe(42);
    expect(jobs[0]).toMatchObject({
      sourceId: 'linkedin-search',
      sourceJobId: '4488502383',
      title: 'Back End Developer - PhP Laravel',
      applyUrl: 'https://www.linkedin.com/jobs/view/4488502383/',
      sourceUrl: 'https://www.linkedin.com/jobs/view/4488502383/',
      matchedSearches: ['Egypt · Backend · 24 h'],
      publishedAtReliable: true,
      via: 'LinkedIn search',
    });
    for (const job of jobs) expect(job.location).toMatch(/Egypt/);
  });

  it('runs all saved searches through the cycle, one request at a time', async () => {
    const fetcher = setup(async () => html(GUEST_PAGE));
    const provider = linkedInWebSearchProvider(fetcher, () => NOW);
    expect(provider.id).toBe(PROVIDER_ID);
    expect(provider.concurrency).toBe(1);
    const result = await runSearchCycle(linkedinSearches, provider, cycle);
    const counts = summarize(result.outcomes);
    expect((counts.SUCCESS ?? 0) + (counts.NO_RESULTS ?? 0)).toBe(linkedinSearches.length);
    // The same 42 Egypt cards for every search: Egypt searches keep them, Gulf/MENA drop them.
    const byId = Object.fromEntries(result.outcomes.map((o) => [o.id, o]));
    expect(byId['backend-egypt-24h']?.status).toBe('SUCCESS');
    expect(byId['any-backend-saudi']).toMatchObject({ status: 'NO_RESULTS', detail: "42 card(s) outside the search's filters dropped" });
    expect(result.jobs.length).toBeGreaterThan(0);
    expect(result.jobs.length).toBeLessThanOrEqual(42);
  });

  it('treats an empty response as no results', async () => {
    const provider = linkedInWebSearchProvider(setup(async () => html('')), () => NOW);
    const result = await runSearchCycle([search], provider, cycle);
    expect(result.outcomes[0]).toMatchObject({ status: 'NO_RESULTS', found: 0 });
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
      () => NOW,
    );
    const result = await runSearchCycle(linkedinSearches.slice(0, 3), provider, cycle);
    expect(result.outcomes.map((o) => o.status)).toEqual([expected, 'PROVIDER_STOPPED', 'PROVIDER_STOPPED']);
    expect(requests).toBe(1);
  });

  it('reports a sign-in wall as AUTH and a security check as BLOCKED', async () => {
    const authwall = linkedInWebSearchProvider(setup(async () => html(fixtureText('linkedin-authwall.html'))), () => NOW);
    await expect(authwall.search(search, AbortSignal.timeout(10_000))).rejects.toMatchObject({ kind: 'AUTH' });
    const challenge = linkedInWebSearchProvider(setup(async () => html('<html><head><title>Security Verification | LinkedIn</title></head><body></body></html>')), () => NOW);
    await expect(challenge.search(search, AbortSignal.timeout(10_000))).rejects.toMatchObject({ kind: 'BLOCKED' });
  });

  it('retries a server error once, then reports the search as FAILED (2 requests in total)', async () => {
    let requests = 0;
    const provider = linkedInWebSearchProvider(
      setup(async () => {
        requests += 1;
        return html('', 502);
      }),
      () => NOW,
    );
    const result = await runSearchCycle([search], provider, cycle);
    expect(result.outcomes[0]).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(requests).toBe(1 + limits.linkedinSearch.scrapeTransientRetries);
  });

  it('cancels a request in flight at the cycle deadline and reports DEADLINE', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const provider = linkedInWebSearchProvider(setup(hang), () => NOW);
    const started = Date.now();
    const result = await runSearchCycle([search], provider, { ...cycle, deadlineMs: started + 200 });
    expect(result.outcomes[0]?.status).toBe('DEADLINE');
    // Ended at the deadline, not after the HTTP client's own 18 s timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('drops cards outside the search filters and reports filters it cannot check', async () => {
    const provider = linkedInWebSearchProvider(setup(async () => html(GUEST_PAGE)), () => NOW);
    // Every card in the page is in Egypt: a Saudi Arabia search keeps none of them.
    const saudi: LinkedInSearch = { id: 'saudi', label: 'Saudi', keywords: 'Backend', location: 'Saudi Arabia', easyApplyOnly: true };
    expect(await provider.search(saudi, AbortSignal.timeout(10_000))).toEqual([]);
    expect(provider.note?.(saudi)).toBe("42 card(s) outside the search's filters dropped; applied by LinkedIn only: Easy Apply");
  });

  it('uses the short linkedin.com gap; other hosts keep the default', () => {
    const gate = new DomainGate(new InMemoryDomainGateStore(), 'cycle-1');
    expect(gate.minGapFor('www.linkedin.com')).toBe(250);
    expect(gate.minGapFor('remoteok.com')).toBe(limits.domainGate.defaultMinGapMs);
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

describe('LinkedIn status 999 and search rotation', () => {
  it('classifies 999 as a rate limit', () => {
    expect(classifyStatus(999, new Headers(), NOW)).toEqual({ type: 'RATE_LIMITED', retryAfterMs: undefined });
  });

  it('every search leads a cycle within rotateOverCycles cycles', () => {
    const cycleMs = limits.linkedinSearch.cycleMinutes * 60_000;
    const perCycle = Math.ceil(linkedinSearches.length / limits.linkedinSearch.rotateOverCycles);
    const covered = new Set<string>();
    for (let i = 0; i < limits.linkedinSearch.rotateOverCycles; i++) {
      const order = rotatedSearches(linkedinSearches, NOW + i * cycleMs);
      expect(order).toHaveLength(linkedinSearches.length);
      for (const s of order.slice(0, perCycle)) covered.add(s.id);
    }
    expect(covered.size).toBe(linkedinSearches.length);
  });
});
