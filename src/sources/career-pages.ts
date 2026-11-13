import { careerPages as configuredPages, careerPagesLimits, DEFAULT_JOB_LINK_PATTERN, type CareerPage, type SyncableSourceId } from '../../config/sources';
import { decodeEntities, htmlToText } from '../core/normalize';
import { GateClosedError } from '../scraping/domain-gate';
import { SourceHttpError, type Fetcher } from '../scraping/fetcher';
import { validatorsFrom } from '../scraping/http-client';
import type { AdapterContext, ExternalJob, FetchResult, SourceAdapter, Validators } from './contract';
import { extractJobPostings, jobFromJsonLd } from './jsonld';

/**
 * Company career pages. Per site: fetch the listing page (robots-checked, conditional
 * where possible), collect same-host job links, fetch only pages not seen before
 * (bounded), and read schema.org JobPosting JSON-LD — or, when a page has none, its
 * heading and text. One site failing (403, CAPTCHA, robots disallow) never stops the
 * others; its host gate is paused and a warning is reported.
 *
 * Two transports share this logic: plain HTTP (source `career-pages`) and a headless
 * browser for JavaScript-only sites (source `career-pages-js`, §5.7).
 */
export type HtmlResult = { kind: 'not-modified' } | { kind: 'ok'; html: string; validators: Validators };

export interface HtmlFetcher {
  /** Throws SourceHttpError / GateClosedError like Fetcher.fetch. */
  fetchHtml(url: string, options: { allowedHosts: readonly string[]; validators?: Validators | undefined }): Promise<HtmlResult>;
}

/** Plain-HTTP transport over the shared, gated Fetcher. */
export function httpHtmlFetcher(fetcher: Fetcher): HtmlFetcher {
  return {
    async fetchHtml(url, { allowedHosts, validators }) {
      const result = await fetcher.fetch({ url, allowedHosts, expect: 'html', respectRobots: true, validators }, async (res) => ({
        html: await res.text(),
        validators: validatorsFrom(res.headers),
      }));
      return result.kind === 'not-modified' ? result : { kind: 'ok', ...result.value };
    },
  };
}

const HIDDEN_LINK = /\bstyle\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden)|(?:^|\s)hidden(?:\s|=|$)|aria-hidden\s*=\s*["']true["'][^>]*tabindex\s*=\s*["']-1/i;

export function extractJobLinks(html: string, page: Pick<CareerPage, 'listUrl' | 'jobLinkPattern'>): string[] {
  const base = new URL(page.listUrl);
  const pattern = new RegExp(page.jobLinkPattern ?? DEFAULT_JOB_LINK_PATTERN, 'i');
  const links = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = match[1] ?? '';
    // Skip hidden links (crawler traps) and links the site asks crawlers not to follow.
    if (HIDDEN_LINK.test(attrs) || /\brel\s*=\s*["'][^"']*\bnofollow\b/i.test(attrs)) continue;
    const href = /\bhref\s*=\s*["']([^"'#]+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href), base);
    } catch {
      continue;
    }
    // Same host only: never follow links to arbitrary sites (§4.1, §5.2).
    if (url.protocol !== 'https:' || url.hostname !== base.hostname) continue;
    url.hash = '';
    const absolute = url.toString();
    if (pattern.test(absolute) && absolute.replace(/\/$/, '') !== base.toString().replace(/\/$/, '')) links.add(absolute);
  }
  return [...links];
}

/**
 * Pages without JobPosting data: title from the first <h1> (or og:title), text from the
 * page body. Everything still passes the normal matching rules, so a non-job page is
 * simply rejected by the title filter.
 */
export function jobFromPageText(html: string, ctx: { sourceId: ExternalJob['sourceId']; pageUrl: string; company: string }): ExternalJob | undefined {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const og = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  const title = decodeEntities((h1 ?? og ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!title || title.length > 200) return undefined;
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = htmlToText(main.replace(/<(nav|header|footer|script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')).slice(0, 20_000);
  return {
    sourceId: ctx.sourceId,
    sourceJobId: ctx.pageUrl,
    title,
    company: ctx.company,
    description: text,
    descriptionIsHtml: false,
    applyUrl: ctx.pageUrl,
    sourceUrl: ctx.pageUrl,
    employerUrl: ctx.pageUrl,
    // Unknown publish date: never treated as stale; dedupe prevents repeats.
    publishedAtReliable: false,
    via: ctx.company,
  };
}

export interface CareerPagesOptions {
  sourceId: Extract<SyncableSourceId, 'career-pages' | 'career-pages-js'>;
  pages: readonly CareerPage[];
  /** Transport; defaults to plain HTTP over ctx.fetcher. */
  transport?: (ctx: AdapterContext) => HtmlFetcher;
  /** Optional per-run teardown (e.g. closing the browser). */
  close?: () => Promise<void>;
}

export function makeCareerPagesAdapter(options: CareerPagesOptions): SourceAdapter {
  const { sourceId, pages } = options;
  return {
    id: sourceId,
    async fetch(ctx: AdapterContext): Promise<FetchResult> {
      if (pages.length === 0) return { kind: 'skipped', reason: 'no career pages configured' };
      if (!ctx.seen) throw new Error('career-pages adapter requires a seen-page store');
      const transport = options.transport?.(ctx) ?? httpHtmlFetcher(ctx.fetcher);
      const started = Date.now();
      const jobs: ExternalJob[] = [];
      const warnings: string[] = [];
      const cursor: Record<string, string | number> = { ...ctx.cursor };
      let budget = careerPagesLimits.maxNewPagesPerRun;
      let seen = 0;
      let malformed = 0;

      try {
        for (const page of pages) {
          if (budget <= 0 || Date.now() - started > careerPagesLimits.timeBudgetMs) break;
          const host = new URL(page.listUrl).hostname;
          const fetchedNow: string[] = [];
          try {
            const list = await transport.fetchHtml(page.listUrl, {
              allowedHosts: [host],
              validators: { etag: str(cursor[`etag:${page.id}`]), lastModified: str(cursor[`lm:${page.id}`]) },
            });
            if (list.kind === 'not-modified') continue;
            setOrDelete(cursor, `etag:${page.id}`, list.validators.etag);
            setOrDelete(cursor, `lm:${page.id}`, list.validators.lastModified);

            // Job boards: the employer comes from each job's own data; the page name is attribution.
            const ldContext = { sourceId, company: page.aggregator ? undefined : page.company, via: page.company };
            // Some listing pages embed the postings directly.
            const listed = extractJobPostings(list.html);
            for (const node of listed) {
              const job = jobFromJsonLd(node, { ...ldContext, pageUrl: page.listUrl }, ctx.nowMs);
              if (job) jobs.push(job);
            }

            const links = extractJobLinks(list.html, page);
            if (links.length === 0 && listed.length === 0) {
              warnings.push(
                `${page.company}: no job links found on the listing page${page.render ? '' : ' (it may need JavaScript: set render: true)'} — check listUrl/jobLinkPattern`,
              );
            }
            const fresh = (await ctx.seen.unseen(links)).slice(0, Math.min(careerPagesLimits.maxNewPagesPerSite, budget));
            for (const url of fresh) {
              if (Date.now() - started > careerPagesLimits.timeBudgetMs) break;
              const detail = await transport.fetchHtml(url, { allowedHosts: [host] });
              budget -= 1;
              fetchedNow.push(url);
              if (detail.kind !== 'ok') continue;
              seen += 1;
              const postings = extractJobPostings(detail.html);
              try {
                if (postings.length === 0) {
                  const job = jobFromPageText(detail.html, { sourceId, pageUrl: url, company: page.company });
                  if (job) jobs.push(job);
                }
                for (const node of postings) {
                  const job = jobFromJsonLd(node, { ...ldContext, pageUrl: url }, ctx.nowMs);
                  if (job) jobs.push(job);
                }
              } catch {
                malformed += 1;
              }
            }
          } catch (err) {
            const label = sourceId === 'career-pages-js' ? 'career-pages-js' : 'career-pages';
            if (err instanceof GateClosedError) {
              if (err.reason === 'paused') warnings.push(`${page.company}: paused for manual review — /resume ${label} after checking the site`);
            } else if (err instanceof SourceHttpError) {
              warnings.push(`${page.company}: ${err.outcome.type === 'FORBIDDEN' && 'status' in err.outcome && err.outcome.status === 0 ? 'robots.txt disallows the page' : err.message}`);
            } else {
              warnings.push(`${page.company}: ${(err as Error).message}`);
            }
          } finally {
            // Pages already downloaded are never fetched again for 30 days, even after an error.
            if (fetchedNow.length) await ctx.seen.markSeen(fetchedNow, ctx.nowMs);
          }
        }
      } finally {
        await options.close?.();
      }
      return { kind: 'ok', jobs, validators: {}, malformed, seen: Math.max(seen, jobs.length, malformed), cursor, warnings };
    },
  };
}

function str(value: string | number | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function setOrDelete(target: Record<string, string | number>, key: string, value: string | undefined): void {
  if (value) target[key] = value;
  else delete target[key];
}

/** Plain-HTTP career pages (everything not marked render: true). */
export const careerPagesAdapter = makeCareerPagesAdapter({ sourceId: 'career-pages', pages: configuredPages.filter((p) => !p.render) });
