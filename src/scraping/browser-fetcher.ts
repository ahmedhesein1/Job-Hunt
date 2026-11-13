import { isIP } from 'node:net';
import { countHttp, countUsage } from '../lib/usage';
import type { HtmlFetcher, HtmlResult } from '../sources/career-pages';
import type { DomainGate } from './domain-gate';
import { SourceHttpError, type Fetcher } from './fetcher';
import { assertSafeUrl, hostAllowed, isPrivateAddress, UnsafeUrlError } from './redirect-guard';
import { classifyStatus, looksLikeChallengePage, type Outcome } from './retry-policy';

/**
 * Headless-browser transport for JavaScript-only career pages (§5.7). Same rules as the
 * HTTP client: robots.txt, host allowlist + SSRF checks, the per-host domain gate,
 * honest identification, and stop-on-block (403/CAPTCHA pause the host). No retries:
 * a render is expensive, so failures go straight to the breaker.
 */
export interface RouteLike {
  request(): { resourceType(): string; url(): string; isNavigationRequest(): boolean };
  abort(): Promise<void>;
  continue(): Promise<void>;
}

export interface ResponseLike {
  status(): number;
  headers(): Record<string, string>;
}

export interface PageLike {
  route(url: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<ResponseLike | null>;
  waitForLoadState(state: 'networkidle', options: { timeout: number }): Promise<void>;
  url(): string;
  content(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
const NAV_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 8_000;

/** Loopback, private and link-local destinations are never loaded, by IP literal or name. */
export function blockedSubresource(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  return isIP(host) !== 0 && isPrivateAddress(host);
}

export class BrowserHtmlFetcher implements HtmlFetcher {
  private browser: BrowserLike | undefined;

  constructor(
    private readonly fetcher: Fetcher,
    private readonly gate: DomainGate,
    private readonly launch: () => Promise<BrowserLike>,
    private readonly clock: () => number = Date.now,
  ) {}

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
  }

  async fetchHtml(url: string, options: { allowedHosts: readonly string[] }): Promise<HtmlResult> {
    if (!(await this.fetcher.robotsAllow({ url, allowedHosts: options.allowedHosts }))) {
      throw new SourceHttpError({ type: 'FORBIDDEN', status: 0 }, url);
    }
    await assertSafeUrl(url, options.allowedHosts);
    const hostname = new URL(url).hostname;
    this.browser ??= await this.launch();

    const lease = await this.gate.acquire(hostname);
    let outcome: Outcome | undefined;
    let html = '';
    const page = await this.browser.newPage();
    try {
      await page.route('**/*', async (route) => {
        const request = route.request();
        if (BLOCKED_TYPES.has(request.resourceType()) || blockedSubresource(request.url())) return route.abort();
        // The page itself (and its redirects) must stay on an allowed host.
        if (request.isNavigationRequest() && !hostAllowed(new URL(request.url()).hostname, options.allowedHosts)) return route.abort();
        return route.continue();
      });
      countUsage('browserPages');
      countHttp(new URL(url).hostname);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      // Let client-side rendering finish; a page that never goes idle is still usable.
      await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
      if (!hostAllowed(new URL(page.url()).hostname, options.allowedHosts)) throw new UnsafeUrlError(`navigated off-site to ${new URL(page.url()).hostname}`);
      const headers = new Headers(response?.headers() ?? {});
      outcome = response ? classifyStatus(response.status(), headers, this.clock()) : { type: 'TRANSIENT', detail: 'no response' };
      if (outcome.type === 'OK') {
        html = await page.content();
        const challenge = looksLikeChallengePage(headers, html);
        if (challenge) outcome = { type: 'CHALLENGE', detail: challenge };
      }
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        await this.gate.release(lease, undefined);
        throw err;
      }
      // Navigation timeouts and network failures.
      outcome = { type: 'TRANSIENT', detail: `browser: ${(err as Error).message.split('\n')[0]?.slice(0, 120)}` };
    } finally {
      await page.close().catch(() => undefined);
    }
    await this.gate.release(lease, outcome);
    if (outcome?.type !== 'OK') throw new SourceHttpError(outcome as Outcome, url);
    return { kind: 'ok', html, validators: {} };
  }
}

/** Launches Lambda-compatible headless Chromium from the browser layer (x86_64). */
export async function launchChromium(userAgent: string): Promise<BrowserLike> {
  const [{ default: chromium }, { chromium: playwright }] = await Promise.all([import('@sparticuz/chromium'), import('playwright-core')]);
  const browser = await playwright.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
  const context = await browser.newContext({ userAgent, javaScriptEnabled: true, serviceWorkers: 'block' });
  return {
    newPage: async () => (await context.newPage()) as unknown as PageLike,
    close: async () => {
      await context.close().catch(() => undefined);
      await browser.close();
    },
  };
}
