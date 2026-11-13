import { careerPages } from '../../config/sources';
import type { RunSummary } from '../data/sources';
import { BrowserHtmlFetcher, launchChromium } from '../scraping/browser-fetcher';
import { defaultUserAgent } from '../scraping/http-client';
import { makeCareerPagesAdapter } from '../sources/career-pages';
import { runSource } from './sync-source';
import { withUsage } from '../lib/usage';

/**
 * Headless-browser run for career pages marked `render: true` (§5.7). Runs as its own
 * x86_64 function with Chromium in a layer; everything else (lock, breaker, domain gate,
 * robots, pipeline, first-run summary, warnings) is the shared source pipeline.
 */
const renderedPages = careerPages.filter((p) => p.render);

async function handle(): Promise<RunSummary> {
  let browser: BrowserHtmlFetcher | undefined;
  const adapter = makeCareerPagesAdapter({
    sourceId: 'career-pages-js',
    pages: renderedPages,
    transport: (ctx) => {
      browser = new BrowserHtmlFetcher(ctx.fetcher, ctx.fetcher.domainGate, () => launchChromium(`${defaultUserAgent()} HeadlessChromium`));
      return browser;
    },
    close: async () => browser?.close(),
  });
  return runSource('career-pages-js', { 'career-pages-js': adapter });
}

/** §9: usage counters (HTTP, Telegram) are flushed once per invocation. */
export const handler = withUsage(handle);
