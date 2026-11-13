import { describe, expect, it } from 'vitest';
import { profiles } from '../../config/profiles';
import { normalizeJob } from '../../src/core/normalize';
import { parseAshbyJob } from '../../src/sources/ats/ashby';
import { parseGreenhouseJob } from '../../src/sources/ats/greenhouse';
import { parseLeverJob } from '../../src/sources/ats/lever';
import { parseLinkedInAlert } from '../../src/sources/email/linkedin';
import { parseHimalayasJob } from '../../src/sources/himalayas';
import { parseHnComment } from '../../src/sources/hn';
import { parseJobicyJob } from '../../src/sources/jobicy';
import { parseRemoteOkJob } from '../../src/sources/remoteok';
import { parseWuzzufItem, parseWuzzufSalary, streamRssItems } from '../../src/sources/wuzzuf-rss';
import { parseWorkableJob, workableItems } from '../../src/sources/ats/workable';
import { parseRecruiteeJob, recruiteeItems } from '../../src/sources/ats/recruitee';
import { parseTeamtailorJob, teamtailorItems } from '../../src/sources/ats/teamtailor';
import { parsePersonioJob, personioItems } from '../../src/sources/ats/personio';
import { extractJobPostings, jobFromJsonLd } from '../../src/sources/jsonld';
import { parseAtsUrl } from '../../src/core/url';
import { fixtureJson, fixtureText } from '../helpers/fixtures';

const profile = profiles[0]!;
const NOW = Date.parse('2026-11-10T18:00:00Z');

/** Every adapter must produce jobs that normalize without throwing. */
function normalizesAll(jobs: Array<Parameters<typeof normalizeJob>[0]>) {
  for (const job of jobs) expect(() => normalizeJob(job, profile, NOW)).not.toThrow();
}

describe('Himalayas contract (fixture 2026-11-10)', () => {
  const body = fixtureJson<{ jobs: unknown[] }>('himalayas-search.json');
  const jobs = body.jobs.map(parseHimalayasJob).filter((j) => j !== undefined);

  it('parses every job with required fields', () => {
    expect(jobs).toHaveLength(body.jobs.length);
    for (const j of jobs) {
      expect(j.sourceJobId).toMatch(/^https:\/\/himalayas\.app\//);
      expect(j.applyUrl).toMatch(/^https:\/\/himalayas\.app\//); // Apply must use applicationLink
      expect(j.publishedAt).toMatch(/^20\d\d-/); // pubDate is epoch seconds
      expect(j.via).toBe('Himalayas');
    }
    normalizesAll(jobs);
  });

  it('treats country-name restrictions as location evidence', () => {
    const lead = jobs.find((j) => j.title === 'Lead Backend Developer')!;
    expect(lead.locationRestrictions).toEqual(['Sri Lanka']);
    const n = normalizeJob(lead, profile, NOW);
    expect(n.eligibility).toBe('EXCLUDED');
    expect(n.clearlySenior).toBe(true);
  });
});

describe('Remote OK contract', () => {
  const body = fixtureJson<unknown[]>('remoteok.json');

  it('skips the legal notice and parses jobs', () => {
    const items = body.filter((e) => (e as { id?: unknown }).id !== undefined);
    const jobs = items.map(parseRemoteOkJob).filter((j) => j !== undefined);
    expect(jobs.length).toBe(items.length);
    expect(body.length).toBe(items.length + 1);
    for (const j of jobs) expect(j.sourceUrl).toMatch(/^https:\/\/remoteok\.com\/remote-jobs\//);
    normalizesAll(jobs);
  });

  it('treats salary 0 as unknown and repairs double-encoded text', () => {
    const jobs = body.map(parseRemoteOkJob).filter((j) => j !== undefined);
    for (const j of jobs) if (j.salary) expect((j.salary.min ?? j.salary.max ?? 0) > 0).toBe(true);
    const normalized = jobs.map((j) => normalizeJob(j, profile, NOW));
    expect(normalized.some((n) => /Ã/.test(n.location ?? '') || /Ã/.test(n.title))).toBe(false);
  });
});

describe('Jobicy contract', () => {
  const body = fixtureJson<{ jobs: unknown[]; nextCursor: unknown; hasMore: unknown }>('jobicy.json');
  it('parses ISO pubDate and geo restrictions', () => {
    const jobs = body.jobs.map(parseJobicyJob).filter((j) => j !== undefined);
    expect(jobs).toHaveLength(body.jobs.length);
    for (const j of jobs) {
      expect(j.sourceUrl).toMatch(/^https:\/\/jobicy\.com\/jobs\//);
      expect(Number.isFinite(Date.parse(j.publishedAt!))).toBe(true);
    }
    normalizesAll(jobs);
  });
});

describe('Greenhouse contract', () => {
  const body = fixtureJson<{ jobs: unknown[] }>('greenhouse-jobs.json');
  const board = { ats: 'greenhouse' as const, token: 'gitlab' };
  const jobs = body.jobs.map((j) => parseGreenhouseJob(j, board)).filter((j) => j !== undefined);

  it('parses jobs and decodes entity-encoded content', () => {
    expect(jobs).toHaveLength(body.jobs.length);
    const n = normalizeJob(jobs[0]!, profile, NOW);
    expect(n.summary).not.toMatch(/&lt;|<div/);
    expect(n.canonicalUrl).toMatch(/^https:\/\/boards\.greenhouse\.io\/gitlab\/jobs\/\d+$/);
  });

  it('excludes "Remote, Canada; Remote, United States"', () => {
    const backend = jobs.find((j) => j.location === 'Remote, Canada; Remote, United States')!;
    expect(normalizeJob(backend, profile, NOW).eligibility).toBe('EXCLUDED');
  });
});

describe('Lever contract', () => {
  const body = fixtureJson<unknown[]>('lever-postings.json');
  const jobs = body.map((j) => parseLeverJob(j, { ats: 'lever', token: 'leverdemo' })).filter((j) => j !== undefined);

  it('parses millisecond createdAt and workplace types', () => {
    expect(jobs).toHaveLength(body.length);
    for (const j of jobs) expect(Date.parse(j.publishedAt!)).toBeGreaterThan(Date.parse('2015-01-01'));
    const types = new Set(body.map((b) => (b as { workplaceType?: string }).workplaceType));
    expect(types.size).toBeGreaterThan(1);
    expect(jobs.some((j) => j.remote === true)).toBe(true);
    expect(jobs.some((j) => j.remote === false)).toBe(true);
    normalizesAll(jobs);
  });
});

describe('Ashby contract', () => {
  const body = fixtureJson<{ jobs: unknown[] }>('ashby-board.json');
  const jobs = body.jobs.map((j) => parseAshbyJob(j, { ats: 'ashby', token: 'ashby' })).filter((j) => j !== undefined);

  it('parses jobs and per-job compensation', () => {
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.some((j) => j.salary?.currency)).toBe(true);
    normalizesAll(jobs);
  });

  it('excludes "Remote - European Union"', () => {
    const eu = jobs.find((j) => /European Union/.test(j.location ?? ''))!;
    expect(normalizeJob(eu, profile, NOW).eligibility).toBe('EXCLUDED');
  });
});

describe('Hacker News contract', () => {
  const stories = fixtureJson<{ hits: Array<{ title: string; story_id: number }> }>('hn-story-search.json');
  const comments = fixtureJson<{ hits: Array<{ parent_id: number }> }>('hn-comments.json');

  it('identifies the hiring thread and only top-level comments', () => {
    const story = stories.hits.find((h) => /^Ask HN: Who is hiring\?/.test(h.title))!;
    expect(story).toBeDefined();
    const jobs = comments.hits.map((c) => parseHnComment(c, story.story_id)).filter((j) => j !== undefined);
    const topLevel = comments.hits.filter((c) => c.parent_id === story.story_id);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.length).toBeLessThanOrEqual(topLevel.length);
    for (const j of jobs) expect(j.sourceUrl).toMatch(/^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/);
    normalizesAll(jobs);
  });
});

describe('Wuzzuf RSS contract (fixture 2026-11-11)', () => {
  const xml = fixtureText('wuzzuf-feed.xml');

  async function items(chunkSize: number): Promise<string[]> {
    async function* chunks() {
      for (let i = 0; i < xml.length; i += chunkSize) yield xml.slice(i, i + chunkSize);
    }
    const out: string[] = [];
    for await (const item of streamRssItems(chunks())) out.push(item);
    return out;
  }

  it('streams the same items regardless of chunk boundaries', async () => {
    const whole = await items(xml.length);
    expect(whole.length).toBeGreaterThan(0);
    expect(await items(7)).toEqual(whole);
  });

  it('maps the real feed fields', async () => {
    const jobs = (await items(4096)).map(parseWuzzufItem).filter((j) => j !== undefined);
    expect(jobs.length).toBeGreaterThan(0);
    const first = jobs[0]!;
    expect(first).toMatchObject({ title: 'Electrical Engineer', company: 'Elretag cosmetic', countryCode: 'EG', descriptionIsHtml: false });
    expect(first.location).toMatch(/Egypt$/);
    expect(first.publishedAt).toBe('2026-11-03T13:54:47.000Z');
    // "3-7 years" in the experience field reaches the years rule.
    expect(normalizeJob(first, profile, NOW).minYears).toBe(3);
    normalizesAll(jobs);
  });

  it('parses salary text and rejects foreign links', () => {
    expect(parseWuzzufSalary('Salary: 15000 to 20000 EGP Per Month')).toMatchObject({ min: 15000, max: 20000, currency: 'EGP', period: 'month' });
    expect(parseWuzzufSalary('Salary: Negotiable')).toBeUndefined();
    expect(parseWuzzufItem('<item><title>X</title><link>https://evil.example/</link></item>')).toBeUndefined();
  });
});

describe('Workable contract (SupportYourApp)', () => {
  const body = fixtureJson('workable-widget.json');
  const board = { ats: 'workable' as const, token: 'supportyourapp' };
  it('merges per-location rows by shortcode', () => {
    const raw = (body as { jobs: Array<{ shortcode: string }> }).jobs;
    const items = workableItems(body)!;
    expect(items.length).toBe(new Set(raw.map((j) => j.shortcode)).size);
    const jobs = items.map((i) => parseWorkableJob(i, board)).filter((j) => j !== undefined);
    expect(jobs).toHaveLength(items.length);
    for (const j of jobs) {
      expect(j.applyUrl).toMatch(/^https:\/\/apply\.workable\.com\/supportyourapp\/j\/[A-Z0-9]+$/);
      expect(j.publishedAt).toMatch(/^20\d\d-/);
    }
    expect(jobs[0]!.company).toBe('SupportYourApp');
    normalizesAll(jobs);
  });
});

describe('Recruitee contract (Holepunch)', () => {
  const body = fixtureJson('recruitee-offers.json');
  it('parses "YYYY-MM-DD HH:MM:SS UTC" dates and the Node.js role', () => {
    const jobs = recruiteeItems(body)!.map((o) => parseRecruiteeJob(o, { ats: 'recruitee', token: 'holepunch' })).filter((j) => j !== undefined);
    expect(jobs.length).toBeGreaterThan(0);
    const node = jobs.find((j) => /Node\.js/.test(j.title))!;
    expect(node.publishedAt).toBe('2026-07-10T13:18:00.000Z');
    expect(node.applyUrl).toMatch(/^https:\/\/holepunch\.recruitee\.com\/o\//);
    expect(normalizeJob(node, profile, NOW).skills).toContain('node');
    normalizesAll(jobs);
  });
});

describe('Teamtailor contract (career.teamtailor.com RSS)', () => {
  it('parses items, tt: locations and remote status', () => {
    const items = teamtailorItems(fixtureText('teamtailor.rss'))!;
    const jobs = items.map((i) => parseTeamtailorJob(i, { ats: 'teamtailor', token: 'career' })).filter((j) => j !== undefined);
    expect(jobs).toHaveLength(items.length);
    expect(jobs[0]).toMatchObject({ title: 'SMB Account Executive', location: 'Sydney, Australia', remote: false });
    expect(jobs[0]!.publishedAt).toBe('2026-11-10T08:41:26.000Z');
    expect(normalizeJob(jobs[0]!, profile, NOW).summary).not.toMatch(/&lt;|<p>/);
    normalizesAll(jobs);
  });
});

describe('Personio contract (LANCH)', () => {
  it('parses positions, offices and builds posting URLs', () => {
    const items = personioItems(fixtureText('personio.xml'))!;
    const jobs = items.map((i) => parsePersonioJob(i, { ats: 'personio', token: 'lanch' })).filter((j) => j !== undefined);
    expect(jobs).toHaveLength(items.length);
    expect(jobs[0]).toMatchObject({ company: 'LANCH GmbH', remote: true, applyUrl: 'https://lanch.jobs.personio.de/job/2019505?language=en' });
    expect(jobs[0]!.publishedAt).toBe('2025-03-17T14:37:17.000Z');
    normalizesAll(jobs);
  });
  it('returns an empty list for an empty board', () => {
    expect(personioItems('<?xml version="1.0"?><workzag-jobs></workzag-jobs>')).toEqual([]);
  });
});

describe('board detection from apply links (§4.1)', () => {
  it.each([
    ['https://apply.workable.com/supportyourapp/j/10287AEEFD/apply', { ats: 'workable', token: 'supportyourapp', postingId: '10287AEEFD' }],
    ['https://holepunch.recruitee.com/o/p2p-nodejs-engineer', { ats: 'recruitee', token: 'holepunch', postingId: 'p2p-nodejs-engineer' }],
    ['https://career.teamtailor.com/jobs/8694933-smb-account-executive', { ats: 'teamtailor', token: 'career', postingId: '8694933' }],
    ['https://lanch.jobs.personio.de/job/2019505?language=en', { ats: 'personio', token: 'lanch', postingId: '2019505' }],
  ])('%s', (url, expected) => expect(parseAtsUrl(url)).toMatchObject(expected));

  it('ignores links without a company board', () => {
    expect(parseAtsUrl('https://apply.workable.com/j/10287AEEFD')).toBeUndefined();
    expect(parseAtsUrl('https://www.teamtailor.com/en/')).toBeUndefined();
  });
});

describe('career-page JSON-LD contract (real pages)', () => {
  it('Canonical: remote posting open to applicants in Egypt', () => {
    const html = fixtureText('jsonld-jobposting-1.html');
    const [node] = extractJobPostings(html);
    expect(node).toBeDefined();
    const job = jobFromJsonLd(node!, { sourceId: 'career-pages', pageUrl: 'https://canonical.com/careers/7432750', via: 'Canonical' }, NOW)!;
    expect(job.remote).toBe(true);
    expect(job.locationRestrictions).toContain('Egypt');
    expect(normalizeJob(job, profile, NOW).eligibility).toBe('ELIGIBLE');
  });

  it('Teamtailor job page: on-site location from jobLocation[]', () => {
    const [node] = extractJobPostings(fixtureText('jsonld-jobposting-2.html'));
    const job = jobFromJsonLd(node!, { sourceId: 'career-pages', pageUrl: 'https://career.teamtailor.com/jobs/8694933-smb-account-executive', via: 'Teamtailor' }, NOW)!;
    expect(job.title).toBe('SMB Account Executive');
    expect(job.location).toMatch(/Sydney/);
  });
});

describe('LinkedIn alert parser (synthetic — validate with real saved emails, §12)', () => {
  it('extracts job IDs, titles and company/location, deduplicating repeated links', () => {
    const html = `
      <a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc&amp;refId=x"><img alt="logo"></a>
      <a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc">Backend Engineer (Node.js)</a>
      <p>Acme · Cairo, Egypt</p>
      <a href="https://www.linkedin.com/comm/jobs/view/4012345678/">View job</a>
      <a href="https://www.linkedin.com/comm/jobs/view/4099999999/">Node.js Developer</a><p>Beta Corp · Remote</p>`;
    const { jobs } = parseLinkedInAlert(html, '2026-11-10T08:00:00.000Z');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ sourceJobId: '4012345678', title: 'Backend Engineer (Node.js)', company: 'Acme', location: 'Cairo, Egypt' });
    expect(jobs[0]!.applyUrl).toBe('https://www.linkedin.com/jobs/view/4012345678/');
  });
});

describe('BambooHR contract (Luciq / Instabug)', () => {
  it('parses the careers list and builds posting URLs', async () => {
    const { bamboohrItems, parseBamboohrJob } = await import('../../src/sources/ats/bamboohr');
    const items = bamboohrItems(fixtureJson('bamboohr-list.json'))!;
    const jobs = items.map((i) => parseBamboohrJob(i, { ats: 'bamboohr', token: 'instabug', company: 'Luciq (Instabug)' })).filter((j) => j !== undefined);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject({ title: 'Product Engineer (Backend)', applyUrl: 'https://instabug.bamboohr.com/careers/124', company: 'Luciq (Instabug)' });
    expect(jobs[0]!.location).toBe('San Francisco, California');
    normalizesAll(jobs);
  });

  it('detects BambooHR boards from job links', () => {
    expect(parseAtsUrl('https://instabug.bamboohr.com/careers/124')).toMatchObject({ ats: 'bamboohr', token: 'instabug', postingId: '124' });
    expect(parseAtsUrl('https://instabug.bamboohr.com/jobs/view.php?id=124')).toMatchObject({ postingId: '124' });
  });
});
