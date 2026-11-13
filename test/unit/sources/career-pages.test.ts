import { describe, expect, it, vi } from 'vitest';
import { profiles } from '../../../config/profiles';
import { sources, type CareerPage } from '../../../config/sources';
import { normalizeJob } from '../../../src/core/normalize';
import type { SeenStore } from '../../../src/data/seen';
import { DomainGate, InMemoryDomainGateStore } from '../../../src/scraping/domain-gate';
import { Fetcher } from '../../../src/scraping/fetcher';
import { HttpClient, type FetchLike } from '../../../src/scraping/http-client';
import { looksLikeChallengePage } from '../../../src/scraping/retry-policy';
import { extractJobLinks, makeCareerPagesAdapter } from '../../../src/sources/career-pages';
import { extractJobPostings, jobFromJsonLd } from '../../../src/sources/jsonld';

const NOW = Date.parse('2026-11-11T10:00:00Z');
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

const posting = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Backend Engineer (Node.js)',
  datePosted: '2026-11-10',
  validThrough: '2026-12-31T00:00:00Z',
  hiringOrganization: { '@type': 'Organization', name: 'Acme' },
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Cairo', addressCountry: 'EG' } },
  baseSalary: { '@type': 'MonetaryAmount', currency: 'EGP', value: { '@type': 'QuantitativeValue', minValue: 40000, maxValue: 60000, unitText: 'MONTH' } },
  experienceRequirements: { '@type': 'OccupationalExperienceRequirements', monthsOfExperience: 24 },
  identifier: { '@type': 'PropertyValue', value: 'REQ-17' },
  description: '<p>Build APIs with Node.js, TypeScript and PostgreSQL.</p>',
};

describe('schema.org JobPosting extraction', () => {
  it('finds postings in plain, array and @graph forms', () => {
    const html = `<html><head>${ld(posting)}${ld([{ '@type': 'Organization' }, { ...posting, title: 'B' }])}${ld({ '@graph': [{ '@type': ['JobPosting'], title: 'C' }] })}<script type="application/ld+json">{broken</script></head></html>`;
    expect(extractJobPostings(html).map((p) => p.title)).toEqual(['Backend Engineer (Node.js)', 'B', 'C']);
  });

  it('maps fields and feeds the normal matching pipeline', () => {
    const job = jobFromJsonLd(posting, { sourceId: 'career-pages', pageUrl: 'https://careers.acme.example/jobs/17', via: 'Acme' }, NOW)!;
    expect(job).toMatchObject({
      title: 'Backend Engineer (Node.js)',
      company: 'Acme',
      location: 'Cairo, EG',
      countryCode: 'EG',
      requisitionId: 'REQ-17',
      salary: { min: 40000, max: 60000, currency: 'EGP', period: 'month' },
    });
    const n = normalizeJob(job, profiles[0]!, NOW);
    expect(n.eligibility).toBe('ELIGIBLE');
    expect(n.minYears).toBe(2);
    expect(n.skills).toEqual(expect.arrayContaining(['node', 'typescript', 'postgresql']));
  });

  it('drops expired postings and reads remote/applicant requirements', () => {
    expect(jobFromJsonLd({ ...posting, validThrough: '2026-01-01' }, { sourceId: 'career-pages', pageUrl: 'https://x.example/j', via: 'x' }, NOW)).toBeUndefined();
    const remote = jobFromJsonLd(
      { ...posting, jobLocation: undefined, jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: [{ '@type': 'Country', name: 'Egypt' }] },
      { sourceId: 'career-pages', pageUrl: 'https://x.example/j', via: 'x' },
      NOW,
    )!;
    expect(remote).toMatchObject({ remote: true, locationRestrictions: ['Egypt'] });
  });
});

describe('job link extraction', () => {
  const page = { listUrl: 'https://careers.acme.example/jobs', jobLinkPattern: '/jobs/\\d+' };
  it('keeps same-host https links that match the pattern, resolved and de-duplicated', () => {
    const html = `
      <a href="/jobs/1">One</a><a href="https://careers.acme.example/jobs/1#apply">One again</a>
      <a href='jobs/2'>Two</a><a href="https://evil.example/jobs/3">Other host</a>
      <a href="http://careers.acme.example/jobs/4">http</a><a href="/about">About</a>`;
    expect(extractJobLinks(html, page)).toEqual(['https://careers.acme.example/jobs/1', 'https://careers.acme.example/jobs/2']);
  });
});

describe('challenge detection for HTML pages', () => {
  it('ignores reCAPTCHA on normal pages but flags challenge titles', () => {
    const h = new Headers();
    expect(looksLikeChallengePage(h, '<title>Backend Engineer | Acme</title><script src="https://www.google.com/recaptcha/api.js"></script>')).toBeUndefined();
    expect(looksLikeChallengePage(h, '<title>Just a moment...</title>')).toBeDefined();
    expect(looksLikeChallengePage(new Headers({ 'cf-mitigated': 'challenge' }), '<title>x</title>')).toBeDefined();
  });
});

describe('career-pages adapter', () => {
  const page: CareerPage = { id: 'acme', company: 'Acme', listUrl: 'https://careers.acme.example/jobs', jobLinkPattern: '/jobs/\\d+', termsReviewed: '2026-11-11' };
  const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

  function setup(routes: Record<string, () => Response>) {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      const route = routes[url];
      return route ? route() : new Response('', { status: 404 });
    };
    const clock = { t: NOW };
    const sleeper = async (ms: number) => void (clock.t += ms);
    const gate = new DomainGate(new InMemoryDomainGateStore(), 'run', { clock: () => clock.t, sleeper, minGapMs: () => 1500 });
    const http = new HttpClient({ fetchImpl, resolver: async () => ['93.184.216.34'], userAgent: 'JobFinder/1.0 (test)' });
    const fetcher = new Fetcher(gate, http, sleeper, () => clock.t);
    const seenUrls = new Set<string>();
    const seen: SeenStore = {
      unseen: async (urls) => urls.filter((u) => !seenUrls.has(u)),
      markSeen: vi.fn(async (urls: string[]) => void urls.forEach((u) => seenUrls.add(u))),
    };
    const ctx = { fetcher, policy: sources['career-pages'], validators: {}, sinceMs: 0, cursor: {}, nowMs: NOW, seen };
    return { calls, ctx, seenUrls };
  }

  const site = {
    'https://careers.acme.example/robots.txt': () => new Response('User-agent: *\nDisallow: /private', { status: 200, headers: { 'content-type': 'text/plain' } }),
    'https://careers.acme.example/jobs': () => html('<a href="/jobs/1">1</a><a href="/jobs/2">2</a>'),
    'https://careers.acme.example/jobs/1': () => html(`<title>Job 1</title>${ld(posting)}`),
    'https://careers.acme.example/jobs/2': () =>
      html('<title>Job 2</title><body><nav>Menu</nav><main><h1>Node.js Developer</h1><p>Build Node.js services.</p></main></body>'),
  };

  it('fetches each job page once; reads JSON-LD, else the page heading and text', async () => {
    const { calls, ctx } = setup(site);
    const adapter = makeCareerPagesAdapter({ sourceId: 'career-pages', pages: [page] });
    const first = await adapter.fetch(ctx);
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.jobs.map((j) => j.title)).toEqual(['Backend Engineer (Node.js)', 'Node.js Developer']);
    expect(first.jobs[1]).toMatchObject({ company: 'Acme', applyUrl: 'https://careers.acme.example/jobs/2', publishedAtReliable: false });
    expect(first.jobs[1]!.description).toBe('Node.js Developer\nBuild Node.js services.');
    expect(first.warnings).toEqual([]);
    expect(calls.filter((u) => u.endsWith('/jobs/1'))).toHaveLength(1);

    // Second run: list page again, but no detail page is downloaded twice.
    const second = await adapter.fetch({ ...ctx, cursor: first.cursor ?? {} });
    expect(second.kind === 'ok' && second.jobs).toEqual([]);
    expect(calls.filter((u) => u.endsWith('/jobs/1'))).toHaveLength(1);
  });

  it('respects robots.txt per site and keeps going with other sites', async () => {
    const blocked: CareerPage = { ...page, id: 'blocked', company: 'Blocked', listUrl: 'https://blocked.example/private/jobs' };
    const { calls, ctx } = setup({
      ...site,
      'https://blocked.example/robots.txt': () => new Response('User-agent: *\nDisallow: /private', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    const result = await makeCareerPagesAdapter({ sourceId: 'career-pages', pages: [blocked, page] }).fetch(ctx);
    expect(calls).not.toContain('https://blocked.example/private/jobs');
    expect(result.kind === 'ok' && result.warnings?.[0]).toBe('Blocked: robots.txt disallows the page');
    expect(result.kind === 'ok' && result.jobs).toHaveLength(2);
  });

  it('treats a CAPTCHA page as a block for that site only', async () => {
    const { ctx } = setup({ ...site, 'https://careers.acme.example/jobs': () => html('<title>Just a moment...</title>') });
    const result = await makeCareerPagesAdapter({ sourceId: 'career-pages', pages: [page] }).fetch(ctx);
    expect(result.kind === 'ok' && result.warnings?.[0]).toMatch(/^Acme: CHALLENGE/);
  });

  it('takes the employer from each job on aggregator pages', async () => {
    const { ctx } = setup(site);
    const result = await makeCareerPagesAdapter({ sourceId: 'career-pages', pages: [{ ...page, company: 'Wuzzuf', aggregator: true }] }).fetch(ctx);
    expect(result.kind === 'ok' && result.jobs[0]).toMatchObject({ company: 'Acme', via: 'Wuzzuf' });
  });

  it('skips when nothing is configured', async () => {
    const { ctx } = setup(site);
    expect((await makeCareerPagesAdapter({ sourceId: 'career-pages', pages: [] }).fetch(ctx)).kind).toBe('skipped');
  });
});
