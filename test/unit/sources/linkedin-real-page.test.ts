import { describe, expect, it } from 'vitest';
import { processJobs } from '../../../src/core/pipeline';
import { defaultSettings } from '../../../src/data/settings';
import { toSourceState } from '../../../src/data/sources';
import { parseLinkedInSearchPage } from '../../../src/sources/linkedin/search-page';
import { importLinkedInSnapshot } from '../../../src/sources/linkedin/snapshot-import';
import { FakeStore } from '../../helpers/fake-store';
import { fixtureText } from '../../helpers/fixtures';

/**
 * A real LinkedIn logged-out results page ("Backend Jobs in Egypt"), saved by the owner on
 * 2026-11-13 and sanitized (scripts, CSRF tokens, tracking parameters removed). It guards the
 * parser against LinkedIn markup changes and the matching rules against real job titles.
 */
const PAGE = fixtureText('linkedin-search-real-2026-11-13.html');
const CAPTURED = Date.parse('2026-11-13T18:09:27Z');
const NOW = CAPTURED + 60_000; // 20:10 Cairo, outside quiet hours

describe('real LinkedIn results page (2026-11-13)', () => {
  const result = parseLinkedInSearchPage(PAGE, { capturedAtMs: CAPTURED });

  it('reads every card of the logged-out layout', () => {
    expect(result).toMatchObject({ status: 'ok', layout: 'logged-out', cardsSeen: 42, placeholders: 0, malformed: 0 });
    if (result.status !== 'ok') return;
    expect(result.cards).toHaveLength(42);
    expect(new Set(result.cards.map((c) => c.jobId)).size).toBe(42);
    for (const c of result.cards) {
      expect(c.url).toBe(`https://www.linkedin.com/jobs/view/${c.jobId}/`);
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.company.length).toBeGreaterThan(1);
      expect(c.location).toMatch(/Egypt/);
      expect(c.postedAtPrecise).toBe(true);
    }
  });

  it('extracts real card fields exactly', () => {
    if (result.status !== 'ok') throw new Error('not ok');
    expect(result.cards[0]).toMatchObject({
      jobId: '4488502383',
      title: 'Back End Developer - PhP Laravel',
      company: 'ComplyMarket',
      location: 'Alexandria, Egypt',
      postedText: '6 hours ago',
      postedAt: new Date(CAPTURED - 6 * 3_600_000).toISOString(),
    });
    expect(result.cards.find((c) => c.jobId === '4489239996')).toMatchObject({ title: 'Java Technical Lead', company: 'FlairsTech', location: 'Qesm El Maadi, Cairo, Egypt' });
  });

  it('sends no instant alert for jobs without Node evidence, and rejects other stacks', async () => {
    const fake = new FakeStore();
    const r = await importLinkedInSnapshot(PAGE, CAPTURED, NOW, {
      processJobs: (jobs, ctx) => processJobs(jobs, ctx, fake),
      getSettings: async () => defaultSettings(),
      getSourceState: async (id) => toSourceState(id, undefined),
      saveSourceState: async () => undefined,
      recordRun: async () => undefined,
    });
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.stats).toMatchObject({ found: 42, alerts: 0, stored: 2, digest: 2 });
    expect(fake.outbox.size).toBe(0);

    const byTitle = Object.fromEntries(r.outcomes.map((o) => [o.title, o]));
    expect(byTitle['Back End Developer - PhP Laravel']).toMatchObject({ result: 'rejected', explanation: 'title names another stack: php, laravel' });
    expect(byTitle['Senior Data Platform Engineer']?.result).toBe('rejected');
    expect(byTitle['Senior Full Stack Engineer - AI & Automation']).toMatchObject({ result: 'stored', delivery: 'DIGEST' });
    expect(byTitle['Senior Full Stack Engineer - AI & Automation']?.explanation).toMatch(/Node not verifiable \(no description\)$/);
  });
});
