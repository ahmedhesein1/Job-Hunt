import { describe, expect, it } from 'vitest';
import { linkedinSearches, type LinkedInSearch } from '../../../config/linkedin-searches';
import { processJobs } from '../../../src/core/pipeline';
import type { JobItem } from '../../../src/data/jobs';
import { defaultSettings } from '../../../src/data/settings';
import { toSourceState } from '../../../src/data/sources';
import { BooleanQueryError, matchesBooleanQuery, parseBooleanQuery } from '../../../src/sources/linkedin/boolean-query';
import { runSearchCycle, summarize } from '../../../src/sources/linkedin/orchestrator';
import { storedJobsProvider, type CandidateStore } from '../../../src/sources/linkedin/provider';
import { matchesSearch, uncheckedFilters, type LinkedInCandidate } from '../../../src/sources/linkedin/search-match';
import { importLinkedInSnapshot } from '../../../src/sources/linkedin/snapshot-import';
import { FakeStore } from '../../helpers/fake-store';
import { fixtureText } from '../../helpers/fixtures';

const CAPTURED = Date.parse('2026-11-11T10:00:00Z');
const NOW = CAPTURED + 60_000;
const HOUR = 3_600_000;

describe('LinkedIn Boolean keyword queries', () => {
  it.each([
    ['("Node.js" OR NestJS) NOT Frontend', 'Backend Engineer (Node.js)', true],
    ['("Node.js" OR NestJS) NOT Frontend', 'Frontend Engineer, Node.js', false],
    ['(Backend OR "Back-end") NOT (Frontend OR iOS)', 'Senior Back End Developer', true],
    ['(Senior OR Sr) AND (Node OR Backend)', 'Sr. Node Developer', true],
    ['(Senior OR Sr) AND (Node OR Backend)', 'Junior Node Developer', false],
    ['TypeScript Backend', 'Backend engineer (TypeScript)', true], // implicit AND
    ['"مطور باك اند" OR "مطور Node.js"', 'مطور باك اند Node.js', true],
    ['"Full Stack" AND ("Node.js" OR NestJS)', 'Full-Stack Engineer - NestJS', true],
  ])('%s ~ %s → %s', (query, text, expected) => {
    expect(matchesBooleanQuery(query, text)).toBe(expected);
  });

  it('parses every saved search', () => {
    for (const s of linkedinSearches) expect(() => parseBooleanQuery(s.keywords)).not.toThrow();
  });

  it('rejects malformed queries', () => {
    expect(() => parseBooleanQuery('(Node OR')).toThrow(BooleanQueryError);
    expect(() => parseBooleanQuery('Node )')).toThrow(BooleanQueryError);
    expect(() => parseBooleanQuery('AND')).toThrow(BooleanQueryError);
  });
});

describe('saved-search filters on a job', () => {
  const base: LinkedInCandidate = {
    sourceId: 'linkedin-email',
    title: 'Backend Engineer (Node.js)',
    company: 'Acme',
    remoteScope: 'Cairo, Egypt',
    discoveredAt: new Date(NOW - HOUR).toISOString(),
    publishedAt: new Date(NOW - 2 * HOUR).toISOString(),
    applyUrl: 'https://www.linkedin.com/jobs/view/4012345678/',
    sourceUrl: 'https://www.linkedin.com/jobs/view/4012345678/',
  };
  const search = (over: Partial<LinkedInSearch>): LinkedInSearch => ({ id: 'x', label: 'x', keywords: 'Backend', ...over });

  it('matches location by country, including cities and Arabic names', () => {
    expect(matchesSearch(base, search({ location: 'Egypt' }), NOW)).toBe(true);
    expect(matchesSearch({ ...base, remoteScope: 'الرياض' }, search({ location: 'Saudi Arabia' }), NOW)).toBe(true);
    expect(matchesSearch(base, search({ location: 'Saudi Arabia' }), NOW)).toBe(false);
    expect(matchesSearch(base, search({ location: 'Worldwide', geoId: '92000000' }), NOW)).toBe(true);
  });

  it('applies workplace, date posted and experience', () => {
    expect(matchesSearch(base, search({ workplace: ['remote'] }), NOW)).toBe(false);
    expect(matchesSearch({ ...base, remoteScope: 'Remote (Egypt)' }, search({ workplace: ['remote'] }), NOW)).toBe(true);
    expect(matchesSearch(base, search({ workplace: ['on-site', 'hybrid'] }), NOW)).toBe(true);
    expect(matchesSearch(base, search({ datePosted: 'past-hour' }), NOW)).toBe(false);
    expect(matchesSearch(base, search({ datePosted: 'past-24h' }), NOW)).toBe(true);
    expect(matchesSearch({ ...base, title: 'Senior Backend Engineer' }, search({ experience: ['entry', 'associate'] }), NOW)).toBe(false);
    expect(matchesSearch({ ...base, title: 'Senior Backend Engineer' }, search({ experience: ['mid-senior'] }), NOW)).toBe(true);
  });

  it('reports filters that LinkedIn alert/page data cannot check', () => {
    expect(uncheckedFilters(search({ employmentTypes: ['contract'], easyApplyOnly: true }))).toEqual(['employment type', 'Easy Apply']);
  });
});

/** Candidate store over the in-memory pipeline store (same window as the DynamoDB one). */
function storeOver(fake: FakeStore, calls: string[] = []): CandidateStore {
  return {
    async recentJobs(sinceIso) {
      calls.push(sinceIso);
      return [...fake.jobs.values()]
        .map((j) => j as unknown as JobItem)
        .filter((j) => j.discoveredAt >= sinceIso)
        .sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt));
    },
  };
}

async function importPages(fake: FakeStore): Promise<void> {
  const deps = {
    processJobs: (jobs: Parameters<typeof processJobs>[0], ctx: Parameters<typeof processJobs>[1]) => processJobs(jobs, ctx, fake),
    getSettings: async () => defaultSettings(),
    getSourceState: async (id: string) => toSourceState(id, undefined),
    saveSourceState: async () => undefined,
    recordRun: async () => undefined,
  };
  for (const page of ['linkedin-search-logged-out.html', 'linkedin-search-signed-in.html']) {
    expect((await importLinkedInSnapshot(fixtureText(page), CAPTURED, NOW, deps)).status).toBe('ok');
  }
}

const cycle = { concurrency: 4, deadlineMs: Date.now() + 45_000, maxRetries: 2, backoffBaseMs: 10 };

describe('stored-jobs provider through the orchestrator (all 39 searches)', () => {
  it('reports exactly which searches matched, with the stored job records', async () => {
    const fake = new FakeStore();
    await importPages(fake);
    expect(fake.jobs.size).toBe(5);

    const calls: string[] = [];
    const provider = storedJobsProvider({ sinceMs: NOW - HOUR, nowMs: NOW }, storeOver(fake, calls));
    const result = await runSearchCycle(linkedinSearches, provider, cycle);

    expect(result.provider).toBe('stored-jobs (all collectors; no web requests)');
    // One read of the window for all 39 searches.
    expect(calls).toEqual([new Date(NOW - HOUR).toISOString()]);
    expect(result.searched).toBe(5);
    expect(result.outcomes).toHaveLength(39);
    const counts = summarize(result.outcomes);
    expect((counts.SUCCESS ?? 0) + (counts.NO_RESULTS ?? 0)).toBe(39);

    const byId = Object.fromEntries(result.outcomes.map((o) => [o.id, o]));
    expect(byId['backend-egypt-24h']).toMatchObject({ status: 'SUCCESS', found: 1 }); // Acme, Cairo, 3 h
    expect(byId['nestjs-egypt-24h']).toMatchObject({ status: 'SUCCESS', found: 3 }); // Acme, Arabic Node.js, Beta Pay
    expect(byId['arabic-backend-egypt-week']).toMatchObject({ status: 'SUCCESS', found: 1 });
    // Two remote Egypt roles exist; "1 week ago" is just outside the past-week window by now.
    expect(byId['remote-from-egypt-week']).toMatchObject({ status: 'SUCCESS', found: 1 });
    expect(byId['any-backend-saudi']).toMatchObject({ status: 'NO_RESULTS', found: 0 });
    expect(byId['easy-apply-egypt-24h']?.detail).toBe('not checkable from stored data: Easy Apply');
    expect(byId['contract-node-remote-week']?.detail).toBe('not checkable from stored data: employment type');
    expect(byId['backend-egypt-24h']?.detail).toBeUndefined();

    // Jobs keep their real source and stored ID; each appears once with every matching search.
    expect(new Set(result.jobs.map((j) => j.storedJobId)).size).toBe(result.jobs.length);
    const acme = result.jobs.find((j) => j.sourceJobId === '4012345678');
    expect(acme).toMatchObject({ sourceId: 'linkedin-snapshot', title: 'Backend Engineer (Node.js)', company: 'Acme', applyUrl: 'https://www.linkedin.com/jobs/view/4012345678/' });
    expect(acme?.storedJobId).toBeTruthy();
    expect(acme?.matchedSearches).toEqual(expect.arrayContaining(['Egypt · Backend · 24 h', 'Egypt · Node.js / NestJS · 24 h']));
    expect(result.jobs.every((j) => j.sourceId !== 'linkedin-search')).toBe(true);
  });

  it('reads nothing old: an empty window means no results and no matches', async () => {
    const fake = new FakeStore();
    await importPages(fake);
    const result = await runSearchCycle(linkedinSearches, storedJobsProvider({ sinceMs: NOW + 1, nowMs: NOW }, storeOver(fake)), cycle);
    expect(summarize(result.outcomes)).toEqual({ NO_RESULTS: 39 });
    expect(result.searched).toBe(0);
    expect(result.jobs).toEqual([]);
  });

  it('a store failure is retried, then reported as FAILED per search, never as success', async () => {
    const failing: CandidateStore = { recentJobs: async () => Promise.reject(new Error('ProvisionedThroughputExceeded')) };
    const provider = storedJobsProvider({ sinceMs: 0, nowMs: NOW }, failing);
    const result = await runSearchCycle(linkedinSearches.slice(0, 2), provider, { concurrency: 1, deadlineMs: Date.now() + 45_000, maxRetries: 1, backoffBaseMs: 1 });
    expect(result.outcomes.map((o) => [o.status, o.attempts])).toEqual([
      ['FAILED', 2],
      ['FAILED', 2],
    ]);
    expect(result.outcomes[0]?.detail).toBe('job store: ProvisionedThroughputExceeded');
  });
});
