import { describe, expect, it } from 'vitest';
import { nextInterval } from '../../../src/handlers/sync-company-boards';
import { DomainGate, InMemoryDomainGateStore } from '../../../src/scraping/domain-gate';
import { Fetcher } from '../../../src/scraping/fetcher';
import { HttpClient } from '../../../src/scraping/http-client';
import { crawlDelaySeconds, parseRobots } from '../../../src/scraping/robots-policy';
import { extractJobLinks } from '../../../src/sources/career-pages';

describe('robots.txt Crawl-delay', () => {
  it('reads the delay for our group, falling back to *', () => {
    expect(crawlDelaySeconds(parseRobots('User-agent: *\nCrawl-delay: 10\nDisallow: /x'), 'JobFinder/1.0')).toBe(10);
    expect(crawlDelaySeconds(parseRobots('User-agent: jobfinder\nCrawl-delay: 4\n\nUser-agent: *\nCrawl-delay: 30'), 'JobFinder/1.0')).toBe(4);
    expect(crawlDelaySeconds(parseRobots('User-agent: *\nDisallow: /x'), 'JobFinder/1.0')).toBeUndefined();
  });

  it('raises the host gap on the gate (never lowers it)', async () => {
    const gate = new DomainGate(new InMemoryDomainGateStore(), 'run', { minGapMs: () => 1500 });
    const http = new HttpClient({
      resolver: async () => ['93.184.216.34'],
      fetchImpl: async () => new Response('User-agent: *\nCrawl-delay: 12', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    const fetcher = new Fetcher(gate, http, async () => undefined);
    await fetcher.robotsAllow({ url: 'https://slow.example/jobs', allowedHosts: ['slow.example'] });
    expect(gate.minGapFor('slow.example')).toBe(12_000);
    gate.raiseMinGap('slow.example', 500);
    expect(gate.minGapFor('slow.example')).toBe(12_000);
  });
});

describe('hidden-link guard', () => {
  it('skips hidden, nofollow and trap links', () => {
    const html = `
      <a href="/jobs/1">ok</a>
      <a style="display: none" href="/jobs/2">trap</a>
      <a href="/jobs/3" style="visibility:hidden">trap</a>
      <a hidden href="/jobs/4">trap</a>
      <a rel="nofollow noopener" href="/jobs/5">nofollow</a>
      <a class="hidden-xs" href="/jobs/6">class name only, still visible</a>`;
    expect(extractJobLinks(html, { listUrl: 'https://c.example/jobs', jobLinkPattern: '/jobs/\\d+' })).toEqual([
      'https://c.example/jobs/1',
      'https://c.example/jobs/6',
    ]);
  });
});

describe('board cadence (owner decision 2026-11-11)', () => {
  const base = { intervalMinutes: 180, consecutiveEmptyChecks: 0 };
  it('watchlist boards keep a fixed fast cadence even when empty', () => {
    expect(nextInterval({ ...base, priority: 'high', consecutiveEmptyChecks: 99 }, 0).interval).toBe(5);
    expect(nextInterval({ ...base, priority: 'normal', consecutiveEmptyChecks: 99 }, 0).interval).toBe(15);
  });
  it('discovered boards age out when empty and recover on a match', () => {
    expect(nextInterval({ ...base, priority: 'low', consecutiveEmptyChecks: 13 }, 0).interval).toBe(360);
    expect(nextInterval({ ...base, priority: 'low', intervalMinutes: 720, consecutiveEmptyChecks: 5 }, 2).interval).toBe(180);
  });
});
