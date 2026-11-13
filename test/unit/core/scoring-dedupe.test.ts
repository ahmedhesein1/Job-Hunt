import { describe, expect, it } from 'vitest';
import { profiles } from '../../../config/profiles';
import { companyKey, fingerprint, fingerprintMatchIsDuplicate } from '../../../src/core/dedupe';
import { htmlToText, normalizeJob, repairMojibake } from '../../../src/core/normalize';
import { evaluate } from '../../../src/core/scoring';
import { canonicalizeUrl, parseAtsUrl, stableId } from '../../../src/core/url';
import type { ExternalJob } from '../../../src/sources/contract';

const profile = profiles[0]!;
const NOW = Date.parse('2026-11-10T10:00:00Z');
const ctx = { mutedCompanies: new Set<string>() };

const LONG_DESC =
  'We are hiring a backend engineer to build APIs with Node.js and TypeScript on NestJS, PostgreSQL and Redis, deployed with Docker on AWS. ' +
  'You will own services end to end, write tests, review code and collaborate with product. Requirements: 2+ years of professional experience building backend services. ' +
  'This is a fully remote role open worldwide.';

function job(overrides: Partial<ExternalJob> = {}): ExternalJob {
  return {
    sourceId: 'remoteok',
    sourceJobId: '1',
    title: 'Backend Node.js Engineer',
    company: 'Acme Inc.',
    location: 'Remote - Worldwide',
    remote: true,
    description: LONG_DESC,
    descriptionIsHtml: false,
    applyUrl: 'https://remoteok.com/remote-jobs/1',
    sourceUrl: 'https://remoteok.com/remote-jobs/1',
    publishedAt: '2026-11-10T08:00:00Z',
    ...overrides,
  };
}

describe('scoring (§6.3)', () => {
  it('scores a strong match ≥ 80 with full confidence', () => {
    const r = evaluate(normalizeJob(job(), profile, NOW), profile, ctx);
    expect(r.decision).toBe('MATCH');
    if (r.decision === 'MATCH') {
      expect(r.score).toBeGreaterThanOrEqual(80);
      expect(r.confidence).toBe(1);
    }
  });

  it('unknown fields lower confidence but not the score', () => {
    const r = evaluate(normalizeJob(job({ description: undefined, location: 'Remote' }), profile, NOW), profile, ctx);
    expect(r).toMatchObject({ decision: 'MATCH', score: 100, confidence: 0.3 });
  });

  it.each([
    [{ title: 'Backend Tech Lead' }, 'leadership role'],
    [{ title: 'Staff Software Engineer, Node.js' }, 'leadership role'],
    [{ title: 'Frontend Engineer (React)' }, 'title excludes: frontend'],
    [{ title: 'Product Designer' }, 'title not backend/node'],
    [{ description: `${LONG_DESC} This role is US only.` }, 'not Egypt-eligible'],
    [{ description: LONG_DESC.replace('2+ years', '8+ years') }, 'requires 8+ years'],
    [{ title: 'Backend Engineer', description: LONG_DESC.replace(/Node\.js and /, '').replace(/NestJS, /, '') }, 'missing must-have: node'],
  ])('rejects %o', (overrides, reason) => {
    const r = evaluate(normalizeJob(job(overrides), profile, NOW), profile, ctx);
    expect(r.decision).toBe('REJECT');
    if (r.decision === 'REJECT') expect(r.reasons.join('; ')).toContain(reason);
  });

  it.each([
    'Senior Backend Engineer (Node.js)',
    'Sr. Node.js Developer',
    'Full Stack Engineer (React/Node)',
    'Senior Fullstack Developer',
    'Software Engineer',
    'Senior Software Developer',
    'Product Engineer',
    'Platform Engineer',
  ])(
    'accepts %s with 6 years required (owner decision 2026-11-11)',
    (title) => {
      const r = evaluate(normalizeJob(job({ title, description: LONG_DESC.replace('2+ years', '6+ years') }), profile, NOW), profile, ctx);
      expect(r.decision).toBe('MATCH');
    },
  );

  it.each(['Full Stack Engineer', 'Software Engineer', 'Platform Engineer'])('still requires Node in the description for "%s"', (title) => {
    const r = evaluate(normalizeJob(job({ title, description: LONG_DESC.replace(/Node\.js and /, '').replace(/NestJS, /, '') }), profile, NOW), profile, ctx);
    expect(r).toMatchObject({ decision: 'REJECT', reasons: ['missing must-have: node'] });
  });

  it.each([
    'Programmer',
    'Senior Programmer (Node.js)',
    'Software Development Engineer II',
    'SDE 2',
    'MERN Stack Developer',
    'Web Developer',
    'TypeScript Developer',
    'JavaScript Engineer',
    'Express.js Developer',
    'مهندس برمجيات',
    'مطور ويب',
    'مطور فول ستاك',
  ])('accepts backend-related title "%s" when the description has Node', (title) => {
    expect(evaluate(normalizeJob(job({ title }), profile, NOW), profile, ctx).decision).toBe('MATCH');
  });

  it('broad titles still need Node in the description', () => {
    for (const title of ['Programmer', 'Web Developer', 'Software Development Engineer']) {
      const r = evaluate(normalizeJob(job({ title, description: LONG_DESC.replace(/Node\.js and /, '').replace(/NestJS, /, '') }), profile, NOW), profile, ctx);
      expect(r).toMatchObject({ decision: 'REJECT', reasons: ['missing must-have: node'] });
    }
  });

  it('rejects Gulf on-site roles, keeps Gulf remote ones, and rejects citizens-only ones', () => {
    expect(evaluate(normalizeJob(job({ location: 'Riyadh, Saudi Arabia', remote: false }), profile, NOW), profile, ctx).decision).toBe('REJECT');
    expect(evaluate(normalizeJob(job({ location: 'Riyadh, Saudi Arabia', remote: true }), profile, NOW), profile, ctx).decision).toBe('MATCH');
    const nationals = evaluate(normalizeJob(job({ title: 'Backend Engineer - Saudi Nationals Only', location: 'Riyadh', remote: true }), profile, NOW), profile, ctx);
    expect(nationals.decision).toBe('REJECT');
  });

  it('without a description, rejects titles naming another stack unless they also show Node', () => {
    const noDesc = (title: string) => evaluate(normalizeJob(job({ title, description: undefined, location: 'Cairo, Egypt', remote: false }), profile, NOW), profile, ctx);
    expect(noDesc('Back End Developer - PhP Laravel')).toMatchObject({ decision: 'REJECT', reasons: ['title names another stack: php, laravel'] });
    expect(noDesc('Senior Data Platform Engineer').decision).toBe('REJECT');
    expect(noDesc('Backend Engineer (Node.js / Python)').decision).toBe('MATCH');
    expect(noDesc('Full Stack JavaScript Developer').decision).toBe('MATCH'); // "java" inside "javascript" is not Java
    // With a description, the Node must-have decides instead.
    expect(evaluate(normalizeJob(job({ title: 'Backend Engineer (Python)' }), profile, NOW), profile, ctx).decision).toBe('MATCH');
  });

  it('does not accept non-software "express" titles', () => {
    expect(evaluate(normalizeJob(job({ title: 'Express Delivery Driver' }), profile, NOW), profile, ctx).decision).toBe('REJECT');
  });

  it('still rejects frontend/mobile software roles', () => {
    for (const title of ['Software Engineer, iOS', 'Frontend Software Engineer', 'Software Engineer in QA']) {
      expect(evaluate(normalizeJob(job({ title }), profile, NOW), profile, ctx).decision).toBe('REJECT');
    }
  });

  it('rejects muted companies', () => {
    const r = evaluate(normalizeJob(job(), profile, NOW), profile, { mutedCompanies: new Set(['acme']) });
    expect(r.decision).toBe('REJECT');
  });
});

describe('dedupe (§9)', () => {
  it('normalises company legal suffixes', () => {
    expect(companyKey('Acme, Inc.')).toBe('acme');
    expect(companyKey('Foo Bar GmbH')).toBe('foo bar');
  });

  it('fingerprint ignores punctuation and node.js spelling', () => {
    expect(fingerprint('Acme Inc', 'Back-end Node.js Engineer', 'Remote')).toBe(fingerprint('ACME', 'Backend NodeJS Engineer', 'remote'));
    expect(fingerprint('Acme', 'Senior Backend', 'Remote')).not.toBe(fingerprint('Acme', 'Junior Backend', 'Remote'));
  });

  it('requires a second signal for fingerprint matches', () => {
    expect(fingerprintMatchIsDuplicate({ requisitionId: 'R1' }, { requisitionId: 'R2' })).toBe(false);
    expect(fingerprintMatchIsDuplicate({ publishedAt: '2026-01-01T00:00:00Z' }, { publishedAt: '2026-03-01T00:00:00Z' })).toBe(false);
    expect(fingerprintMatchIsDuplicate({ publishedAt: '2026-01-01T00:00:00Z' }, { publishedAt: '2026-01-05T00:00:00Z' })).toBe(true);
  });

  it('stable IDs are ≥24 hex chars and deterministic', () => {
    expect(stableId('a', 'b')).toMatch(/^[0-9a-f]{24}$/);
    expect(stableId('a', 'b')).toBe(stableId('a', 'b'));
    expect(stableId('a', 'b')).not.toBe(stableId('ab', ''));
  });
});

describe('canonical URLs (§9)', () => {
  it('strips tracking params and fragments and lowercases host', () => {
    expect(canonicalizeUrl('https://Example.COM/jobs/1?utm_source=x&ref=y&b=2&a=1#apply')).toBe('https://example.com/jobs/1?a=1&b=2');
  });
  it('normalises LinkedIn job links to the stable ID', () => {
    expect(canonicalizeUrl('https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc&refId=x')).toBe(
      'https://www.linkedin.com/jobs/view/4012345678/',
    );
  });
  it('prefers canonical ATS posting URLs', () => {
    expect(canonicalizeUrl('https://job-boards.greenhouse.io/gitlab/jobs/8012345002?gh_src=abc')).toBe('https://boards.greenhouse.io/gitlab/jobs/8012345002');
    expect(canonicalizeUrl('https://jobs.lever.co/acme/0f8f2b1c-1111-2222-3333-444455556666/apply')).toBe(
      'https://jobs.lever.co/acme/0f8f2b1c-1111-2222-3333-444455556666',
    );
  });
  it('parses ATS URLs without fetching and rejects unknown hosts', () => {
    expect(parseAtsUrl('https://jobs.ashbyhq.com/ashby/7a3c0c1e-1111-2222-3333-444455556666')).toMatchObject({ ats: 'ashby', token: 'ashby' });
    expect(parseAtsUrl('https://boards.greenhouse.io/embed/job_app?for=stripe&token=123')).toMatchObject({ ats: 'greenhouse', token: 'stripe', postingId: '123' });
    expect(parseAtsUrl('https://evil.example.com/greenhouse/x')).toBeUndefined();
    expect(parseAtsUrl('http://jobs.lever.co/acme')).toBeUndefined();
  });
});

describe('text normalisation', () => {
  it('decodes entity-encoded HTML (Greenhouse content)', () => {
    expect(htmlToText('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Node&lt;/li&gt;&lt;/ul&gt;')).toBe('Hello & welcome\n• Node');
  });
  it('repairs Remote OK mojibake', () => {
    expect(repairMojibake('Ciudad de MÃ©xico')).toBe('Ciudad de México');
  });
});
