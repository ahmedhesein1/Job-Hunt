import { describe, expect, it, vi } from 'vitest';
import { BrowserHtmlFetcher, blockedSubresource, type BrowserLike, type PageLike, type RouteLike } from '../../../src/scraping/browser-fetcher';
import { DomainGate, InMemoryDomainGateStore } from '../../../src/scraping/domain-gate';
import { Fetcher, SourceHttpError } from '../../../src/scraping/fetcher';
import { HttpClient } from '../../../src/scraping/http-client';
import { UnsafeUrlError } from '../../../src/scraping/redirect-guard';

const HOSTS = ['jobs.example.com'];

/** A fake headless browser: each URL maps to {status, html, finalUrl}. */
function fakeBrowser(pages: Record<string, { status: number; html: string; finalUrl?: string }>, routed: string[] = []) {
  const launches = vi.fn();
  const browser: BrowserLike = {
    close: vi.fn(async () => undefined),
    newPage: async () => {
      let current = '';
      let handler: ((r: RouteLike) => Promise<void>) | undefined;
      const page: PageLike = {
        route: async (_p, h) => void (handler = h),
        goto: async (url) => {
          const spec = pages[url];
          // Simulate the browser asking the route handler about a few subresources.
          for (const sub of ['https://cdn.example.net/app.js', 'https://cdn.example.net/logo.png', 'http://169.254.169.254/latest', 'http://localhost:9001/x']) {
            let decision = 'continue';
            await handler?.({
              request: () => ({ resourceType: () => (sub.endsWith('.png') ? 'image' : 'script'), url: () => sub, isNavigationRequest: () => false }),
              abort: async () => void (decision = 'abort'),
              continue: async () => void (decision = 'continue'),
            });
            routed.push(`${decision} ${sub}`);
          }
          current = spec?.finalUrl ?? url;
          return spec ? { status: () => spec.status, headers: () => ({ 'content-type': 'text/html' }) } : null;
        },
        waitForLoadState: async () => undefined,
        url: () => current,
        content: async () => pages[current]?.html ?? pages[Object.keys(pages)[0]!]!.html,
        close: async () => undefined,
      };
      return page;
    },
  };
  launches.mockResolvedValue(browser);
  return { browser, launches };
}

function setup(pages: Parameters<typeof fakeBrowser>[0], routed?: string[]) {
  const clock = { t: 1_800_000_000_000 };
  const gate = new DomainGate(new InMemoryDomainGateStore(), 'run', { clock: () => clock.t, sleeper: async (ms) => void (clock.t += ms) });
  const http = new HttpClient({
    resolver: async () => ['93.184.216.34'],
    fetchImpl: async () => new Response('User-agent: *\nDisallow: /private', { status: 200, headers: { 'content-type': 'text/plain' } }),
  });
  const fetcher = new Fetcher(gate, http, async () => undefined, () => clock.t);
  const { browser, launches } = fakeBrowser(pages, routed);
  const fetcherUnderTest = new BrowserHtmlFetcher(fetcher, gate, launches, () => clock.t);
  // assertSafeUrl uses real DNS; stub it to a public address for the test host.
  return { fetcherUnderTest, browser, launches, gate };
}

vi.mock('../../../src/scraping/redirect-guard', async (orig) => {
  const real = await orig<typeof import('../../../src/scraping/redirect-guard')>();
  return { ...real, assertSafeUrl: (url: string, hosts: readonly string[]) => real.assertSafeUrl(url, hosts, async () => ['93.184.216.34']) };
});

describe('browser transport (§5.7)', () => {
  it('renders an allowed page and blocks images and private-network requests', async () => {
    const routed: string[] = [];
    const { fetcherUnderTest, launches } = setup({ 'https://jobs.example.com/careers': { status: 200, html: '<title>Careers</title><a href="/jobs/1">x</a>' } }, routed);
    const result = await fetcherUnderTest.fetchHtml('https://jobs.example.com/careers', { allowedHosts: HOSTS });
    expect(result).toMatchObject({ kind: 'ok', html: expect.stringContaining('/jobs/1') });
    expect(routed).toEqual([
      'continue https://cdn.example.net/app.js',
      'abort https://cdn.example.net/logo.png',
      'abort http://169.254.169.254/latest',
      'abort http://localhost:9001/x',
    ]);
    // Browser launched lazily, once.
    await fetcherUnderTest.fetchHtml('https://jobs.example.com/careers', { allowedHosts: HOSTS });
    expect(launches).toHaveBeenCalledTimes(1);
  });

  it('honours robots.txt before launching anything', async () => {
    const { fetcherUnderTest, launches } = setup({});
    const err = await fetcherUnderTest.fetchHtml('https://jobs.example.com/private/x', { allowedHosts: HOSTS }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceHttpError);
    expect(launches).not.toHaveBeenCalled();
  });

  it('pauses the host on 403 and on a challenge page', async () => {
    const { fetcherUnderTest, gate } = setup({ 'https://jobs.example.com/careers': { status: 403, html: 'Forbidden' } });
    const err = (await fetcherUnderTest.fetchHtml('https://jobs.example.com/careers', { allowedHosts: HOSTS }).catch((e: unknown) => e)) as SourceHttpError;
    expect(err.outcome.type).toBe('FORBIDDEN');
    await expect(gate.acquire('jobs.example.com')).rejects.toMatchObject({ reason: 'paused' });

    const challenged = setup({ 'https://jobs.example.com/careers': { status: 200, html: '<title>Just a moment...</title>' } });
    const err2 = (await challenged.fetcherUnderTest.fetchHtml('https://jobs.example.com/careers', { allowedHosts: HOSTS }).catch((e: unknown) => e)) as SourceHttpError;
    expect(err2.outcome.type).toBe('CHALLENGE');
  });

  it('refuses pages that redirect off the allowed host', async () => {
    const { fetcherUnderTest } = setup({ 'https://jobs.example.com/careers': { status: 200, html: 'x', finalUrl: 'https://evil.example.org/' } });
    await expect(fetcherUnderTest.fetchHtml('https://jobs.example.com/careers', { allowedHosts: HOSTS })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('classifies subresource URLs', () => {
    expect(blockedSubresource('https://cdn.example.net/a.js')).toBe(false);
    expect(blockedSubresource('http://127.0.0.1/')).toBe(true);
    expect(blockedSubresource('http://[::1]/')).toBe(true);
    expect(blockedSubresource('file:///etc/passwd')).toBe(true);
    expect(blockedSubresource('data:text/plain,hi')).toBe(false);
  });
});
