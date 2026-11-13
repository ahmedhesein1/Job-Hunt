import { describe, expect, it } from 'vitest';
import { linkedinSearches, LINKEDIN_GEO, SEARCH_GROUPS, type LinkedInSearch } from '../../../config/linkedin-searches';
import { canonicalizeUrl } from '../../../src/core/url';
import { cleanText, jobIdFromUrl, parseLinkedInSearchPage, parseRelativeAge, splitLocation } from '../../../src/sources/linkedin/search-page';
import { buildLinkedInSearchUrl, InvalidSearchError, normalizeKeywords, validateSearches } from '../../../src/sources/linkedin/search-url';
import { fixtureText } from '../../helpers/fixtures';

const CAPTURED = Date.parse('2026-11-11T10:00:00Z');
const HOUR = 3_600_000;

function params(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

describe('LinkedIn search URL builder', () => {
  it('reproduces the example search URL', () => {
    const url = buildLinkedInSearchUrl({ id: 'x', label: 'x', keywords: 'Backend', location: 'مصر', geoId: '106155005', datePosted: 'past-24h' });
    expect(url.startsWith('https://www.linkedin.com/jobs/search?')).toBe(true);
    expect(params(url)).toEqual({ keywords: 'Backend', location: 'مصر', geoId: '106155005', f_TPR: 'r86400', activeFilter: 'f_TPR', position: '1', pageNum: '0' });
  });

  it('maps every filter to LinkedIn parameters', () => {
    const search: LinkedInSearch = {
      id: 'all',
      label: 'all',
      keywords: '  Node.js  Developer ',
      geoId: LINKEDIN_GEO.worldwide,
      datePosted: 'past-week',
      experience: ['entry', 'mid-senior', 'entry'],
      employmentTypes: ['full-time', 'contract'],
      workplace: ['remote', 'hybrid'],
      easyApplyOnly: true,
      sortByDate: true,
    };
    expect(params(buildLinkedInSearchUrl(search))).toMatchObject({
      keywords: 'Node.js Developer',
      geoId: '92000000',
      f_TPR: 'r604800',
      f_E: '2,4',
      f_JT: 'F,C',
      f_WT: '2,3',
      f_AL: 'true',
      sortBy: 'DD',
    });
  });

  it('omits unset filters and "any" date', () => {
    const p = params(buildLinkedInSearchUrl({ id: 'min', label: 'min', keywords: 'NestJS', datePosted: 'any' }));
    expect(Object.keys(p).sort()).toEqual(['keywords', 'pageNum', 'position']);
  });

  it('paginates by 25 results', () => {
    expect(params(buildLinkedInSearchUrl(linkedinSearches[0]!, 2))).toMatchObject({ pageNum: '2', start: '50' });
    expect(params(buildLinkedInSearchUrl(linkedinSearches[0]!, 0)).start).toBeUndefined();
  });

  it('rejects invalid input', () => {
    expect(() => buildLinkedInSearchUrl({ id: 'e', label: 'e', keywords: '  ' })).toThrow(InvalidSearchError);
    expect(() => buildLinkedInSearchUrl({ id: 'g', label: 'g', keywords: 'x', geoId: '12a' })).toThrow(InvalidSearchError);
    expect(() => buildLinkedInSearchUrl({ id: 'p', label: 'p', keywords: 'x' }, -1)).toThrow(InvalidSearchError);
    expect(() => buildLinkedInSearchUrl({ id: 'p', label: 'p', keywords: 'x' }, 40)).toThrow(InvalidSearchError);
    expect(() => validateSearches([{ id: 'd', label: 'a', keywords: 'x' }, { id: 'd', label: 'b', keywords: 'y' }])).toThrow(/duplicate/);
  });

  it('every saved search is valid', () => {
    expect(() => validateSearches(linkedinSearches)).not.toThrow();
    expect(linkedinSearches.length).toBeGreaterThanOrEqual(35);
  });

  it('saved searches cover every group, both geographies and the newest-first sort', () => {
    for (const group of Object.keys(SEARCH_GROUPS)) expect(linkedinSearches.some((s) => s.group === group)).toBe(true);
    const urls = linkedinSearches.map((s) => params(buildLinkedInSearchUrl(s)));
    expect(urls.some((p) => p.geoId === LINKEDIN_GEO.egypt)).toBe(true);
    expect(urls.some((p) => p.geoId === LINKEDIN_GEO.worldwide && p.f_WT === '2')).toBe(true);
    expect(urls.some((p) => p.f_TPR === 'r3600')).toBe(true);
    for (const country of ['Saudi Arabia', 'United Arab Emirates', 'Qatar', 'Kuwait', 'Bahrain', 'Oman', 'Jordan', 'Morocco']) {
      expect(urls.some((p) => p.location === country)).toBe(true);
    }
    expect(urls.some((p) => p.f_WT === '1,3')).toBe(true);
    expect(urls.every((p) => p.sortBy === 'DD')).toBe(true);
  });

  it('Boolean keywords exclude roles the profile rejects', () => {
    const backend = linkedinSearches.find((s) => s.id === 'backend-egypt-24h')!;
    const keywords = params(buildLinkedInSearchUrl(backend)).keywords!;
    expect(keywords).toMatch(/^\(Backend OR "Back-end" OR "Back End" OR "Server-side"\) NOT \(Frontend/);
  });

  it('normalises and validates Boolean keywords', () => {
    expect(normalizeKeywords(' “Node.js”   OR  NestJS ')).toBe('"Node.js" OR NestJS');
    expect(normalizeKeywords('"C++ (modern)" AND (Node OR Go)')).toBe('"C++ (modern)" AND (Node OR Go)');
    expect(() => normalizeKeywords('"Node.js OR NestJS')).toThrow(/quotes/);
    expect(() => normalizeKeywords('(Node OR NestJS')).toThrow(/parentheses/);
    expect(() => normalizeKeywords('Node) OR (NestJS')).toThrow(/parentheses/);
    expect(() => normalizeKeywords('x'.repeat(501))).toThrow(/longer/);
  });

  it('rejects empty or overlong button labels', () => {
    expect(() => validateSearches([{ id: 'l', label: ' ', keywords: 'x' }])).toThrow(/label/);
    expect(() => validateSearches([{ id: 'l', label: 'x'.repeat(41), keywords: 'x' }])).toThrow(/label/);
  });
});

describe('LinkedIn search page parser — logged-out layout', () => {
  const result = parseLinkedInSearchPage(fixtureText('linkedin-search-logged-out.html'), { capturedAtMs: CAPTURED });

  it('finds the cards, removes duplicates and ignores script content', () => {
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.layout).toBe('logged-out');
    expect(result.cardsSeen).toBe(7);
    expect(result.cards.map((c) => c.jobId)).toEqual(['4012345678', '4012345679', '4012345680', '4012345681']);
    expect(result.malformed).toBe(2);
    expect(result.cards.some((c) => c.jobId === '9999999999')).toBe(false);
  });

  it('extracts every field of an English card', () => {
    if (result.status !== 'ok') throw new Error('not ok');
    expect(result.cards[0]).toEqual({
      jobId: '4012345678',
      url: 'https://www.linkedin.com/jobs/view/4012345678/',
      title: 'Backend Engineer (Node.js)',
      company: 'Acme',
      location: 'Cairo, Cairo, Egypt',
      workplace: undefined,
      postedText: '3 hours ago',
      postedAt: new Date(CAPTURED - 3 * HOUR).toISOString(),
      postedAtPrecise: true,
      logoUrl: 'https://media.licdn.com/dms/image/v2/C4D0BAQ/company-logo_100_100/0/acme?e=2147483647&v=beta',
    });
  });

  it('extracts an Arabic card and strips bidi marks', () => {
    if (result.status !== 'ok') throw new Error('not ok');
    expect(result.cards[1]).toMatchObject({
      title: 'مطور باك اند Node.js',
      company: 'شركة النيل للبرمجيات',
      location: 'القاهرة، مصر',
      postedText: 'منذ ساعتين',
      postedAt: new Date(CAPTURED - 2 * HOUR).toISOString(),
      postedAtPrecise: true,
      logoUrl: undefined,
    });
  });

  it('decodes entities, reads workplace and treats "1 week ago" as a lower bound', () => {
    if (result.status !== 'ok') throw new Error('not ok');
    expect(result.cards[3]).toMatchObject({ company: 'Smith & Sons', location: 'Egypt', workplace: 'remote', postedAt: new Date(CAPTURED - 7 * 24 * HOUR).toISOString(), postedAtPrecise: true });
  });

  it('keeps a bare date approximate', () => {
    const html = '<ul class="jobs-search__results-list"><li><div data-entity-urn="urn:li:jobPosting:4012345690"><h3 class="base-search-card__title">Backend</h3><h4 class="base-search-card__subtitle">Acme</h4><time datetime="2026-11-09"></time></div></li></ul>';
    const r = parseLinkedInSearchPage(html, { capturedAtMs: CAPTURED });
    expect(r.status === 'ok' && r.cards[0]).toMatchObject({ postedAt: '2026-11-09T12:00:00.000Z', postedAtPrecise: false });
  });

  it('produces URLs the dedupe canonicaliser agrees with', () => {
    if (result.status !== 'ok') throw new Error('not ok');
    for (const card of result.cards) expect(canonicalizeUrl(card.url)).toBe(card.url);
  });
});

describe('LinkedIn search page parser — signed-in layout', () => {
  const result = parseLinkedInSearchPage(fixtureText('linkedin-search-signed-in.html'), { capturedAtMs: CAPTURED });

  it('reads rendered cards and counts unrendered placeholders', () => {
    expect(result).toMatchObject({ status: 'ok', layout: 'signed-in', cardsSeen: 3, placeholders: 1, malformed: 0 });
  });

  it('uses the title without the verification badge, relative link and full timestamp', () => {
    if (result.status !== 'ok') throw new Error('not ok');
    expect(result.cards[0]).toMatchObject({
      jobId: '4023456789',
      url: 'https://www.linkedin.com/jobs/view/4023456789/',
      title: 'Senior Node.js Engineer',
      company: 'Beta Pay',
      location: 'Cairo, Egypt',
      workplace: 'hybrid',
      postedAtPrecise: true,
      // The full timestamp wins over the rounded "2 hours ago".
      postedAt: '2026-11-11T07:00:00.000Z',
      logoUrl: expect.stringMatching(/^https:\/\/media\.licdn\.com\//),
    });
  });

  it('parses an Arabic card with Arabic-Indic digits and remote workplace', () => {
    if (result.status !== 'ok') throw new Error('not ok');
    expect(result.cards[1]).toMatchObject({
      title: 'مهندس Backend - NestJS',
      company: 'شركة دلتا',
      location: 'مصر',
      workplace: 'remote',
      postedAt: new Date(CAPTURED - 3 * 24 * HOUR).toISOString(),
      postedAtPrecise: true,
    });
  });
});

describe('LinkedIn search page parser — unknown layouts and bad pages', () => {
  it('falls back to job links and validates them', () => {
    const result = parseLinkedInSearchPage(fixtureText('linkedin-search-generic.html'), { capturedAtMs: CAPTURED });
    expect(result).toMatchObject({ status: 'ok', layout: 'generic' });
    if (result.status !== 'ok') return;
    expect(result.cards).toEqual([
      expect.objectContaining({ jobId: '4034567890', title: 'Backend Developer', company: 'Gamma Labs', location: undefined, postedAtPrecise: false }),
    ]);
    expect(result.cards[0]?.postedAt).toBeUndefined();
  });

  it('reports a sign-in wall as blocked', () => {
    expect(parseLinkedInSearchPage(fixtureText('linkedin-authwall.html'), { capturedAtMs: CAPTURED })).toEqual({ status: 'blocked', reason: 'authwall' });
  });

  it('reports a security check as blocked', () => {
    const html = '<html><head><title>Security Verification | LinkedIn</title></head><body><div id="captcha-internal"></div></body></html>';
    expect(parseLinkedInSearchPage(html, { capturedAtMs: CAPTURED })).toEqual({ status: 'blocked', reason: 'challenge' });
  });

  it('handles empty, non-LinkedIn and malformed HTML without throwing', () => {
    for (const html of ['', '<html><body><p>Hello</p></body></html>', '<ul class="jobs-search__results-list"><li><div data-entity-urn="urn:li:jobPosting:12', '<<<>>>']) {
      const result = parseLinkedInSearchPage(html, { capturedAtMs: CAPTURED });
      expect(['empty', 'ok']).toContain(result.status);
      if (result.status === 'ok') expect(result.cards).toEqual([]);
    }
  });

  it('honours the card cap', () => {
    const result = parseLinkedInSearchPage(fixtureText('linkedin-search-logged-out.html'), { capturedAtMs: CAPTURED, maxCards: 2 });
    expect(result).toMatchObject({ status: 'ok', cardsSeen: 2 });
  });
});

describe('LinkedIn parser helpers', () => {
  it.each([
    ['https://www.linkedin.com/jobs/view/4012345678/', '4012345678'],
    ['https://eg.linkedin.com/jobs/view/backend-engineer-at-acme-4012345678?refId=x', '4012345678'],
    ['/jobs/view/4012345678/?trk=x', '4012345678'],
    ['https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=x', '4012345678'],
    ['http://www.linkedin.com/jobs/view/4012345678/', undefined],
    ['https://linkedin.com.evil.example/jobs/view/4012345678/', undefined],
    ['https://evil.example.com/jobs/view/4012345678', undefined],
    ['javascript:alert(1)', undefined],
    ['https://www.linkedin.com/jobs/view/123/', undefined],
  ])('jobIdFromUrl(%s) = %s', (href, id) => {
    expect(jobIdFromUrl(href)).toBe(id);
  });

  it.each([
    ['3 hours ago', 3 * HOUR],
    ['1 hour ago', HOUR],
    ['an hour ago', HOUR],
    ['45 minutes ago', 45 * 60_000],
    ['Reposted 2 days ago', 2 * 24 * HOUR],
    ['2 weeks ago', 14 * 24 * HOUR],
    ['Just now', 0],
    ['منذ ساعة', HOUR],
    ['منذ ساعتين', 2 * HOUR],
    ['منذ 5 ساعات', 5 * HOUR],
    ['منذ ١١ ساعة', 11 * HOUR],
    ['منذ يوم', 24 * HOUR],
    ['منذ يومين', 2 * 24 * HOUR],
    ['منذ أسبوعين', 14 * 24 * HOUR],
    ['منذ 3 أشهر', 90 * 24 * HOUR],
  ])('parseRelativeAge(%s)', (text, ms) => {
    expect(parseRelativeAge(text)?.ms).toBe(ms);
  });

  it('returns undefined for text that is not an age', () => {
    expect(parseRelativeAge('Actively hiring')).toBeUndefined();
    expect(parseRelativeAge('')).toBeUndefined();
  });

  it('splits workplace from the location', () => {
    expect(splitLocation('Cairo, Egypt (On-site)')).toEqual({ location: 'Cairo, Egypt', workplace: 'on-site' });
    expect(splitLocation('Remote')).toEqual({ location: 'Remote', workplace: 'remote' });
    expect(splitLocation('القاهرة، مصر (هجين)')).toEqual({ location: 'القاهرة، مصر', workplace: 'hybrid' });
    expect(splitLocation('   ')).toEqual({});
  });

  it('normalises whitespace and invisible marks', () => {
    expect(cleanText('‏  Backend\n\t Engineer ‪')).toBe('Backend Engineer');
  });
});
