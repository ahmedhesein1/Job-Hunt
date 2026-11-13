import { himalayasMaxPagesPerQuery, himalayasQueries } from '../../config/sources';
import type { RawSalary } from './contract';
import type { AdapterContext, ExternalJob, FetchResult, SourceAdapter, Validators } from './contract';
import { epochSecondsToIso, num, obj, parseItems, publishedBefore, str, strArray } from './parse-utils';
import { validatorsFrom } from '../scraping/http-client';

/**
 * Himalayas search API (verified 2026-11-10): GET /jobs/api/search?q=&sort=recent&page=N,
 * 20 results per page, `pubDate` in epoch seconds, `locationRestrictions` as country
 * names ([] = worldwide). Data refreshes every 24 h; we poll once a day.
 * Attribution: Apply must use `applicationLink` and show a visible Himalayas credit.
 */
const BASE = 'https://himalayas.app/jobs/api/search';
const PAGE_SIZE = 20;

function period(value: unknown): { period: RawSalary['period']; divisor: number } {
  switch (str(value)?.toLowerCase()) {
    case 'monthly':
      return { period: 'month', divisor: 1 };
    case 'hourly':
      return { period: 'hour', divisor: 1 };
    case 'weekly':
      return { period: 'week', divisor: 1 };
    case 'fortnightly':
      return { period: 'week', divisor: 2 };
    default:
      return { period: 'year', divisor: 1 };
  }
}

export function parseHimalayasJob(item: unknown): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  const guid = str(j.guid);
  const title = str(j.title);
  const applyUrl = str(j.applicationLink) ?? guid;
  if (!guid || !title || !applyUrl) return undefined;
  const p = period(j.salaryPeriod);
  const min = num(j.minSalary);
  const max = num(j.maxSalary);
  return {
    sourceId: 'himalayas',
    sourceJobId: guid,
    title,
    company: str(j.companyName) ?? 'Unknown company',
    locationRestrictions: strArray(j.locationRestrictions),
    // Every Himalayas listing is remote; an empty restriction list means worldwide.
    location: strArray(j.locationRestrictions).length === 0 ? 'Remote - Worldwide' : 'Remote',
    remote: true,
    timezoneOffsets: Array.isArray(j.timezoneRestrictions) ? j.timezoneRestrictions.map(num).filter((n): n is number => n !== undefined) : undefined,
    description: str(j.description),
    descriptionIsHtml: true,
    tags: [...strArray(j.categories), ...strArray(j.parentCategories)].map((c) => c.replace(/-/g, ' ')),
    seniorityHints: strArray(j.seniority),
    applyUrl,
    sourceUrl: guid,
    publishedAt: epochSecondsToIso(j.pubDate),
    salary:
      min !== undefined || max !== undefined
        ? {
            min: min !== undefined ? min / p.divisor : undefined,
            max: max !== undefined ? max / p.divisor : undefined,
            currency: str(j.currency),
            period: p.period,
            origin: 'Himalayas',
          }
        : undefined,
    via: 'Himalayas',
  };
}

export const himalayasAdapter: SourceAdapter = {
  id: 'himalayas',
  async fetch(ctx: AdapterContext): Promise<FetchResult> {
    const byId = new Map<string, ExternalJob>();
    let malformed = 0;
    let seen = 0;
    let validators: Validators = {};

    for (const [qi, q] of himalayasQueries.entries()) {
      for (let page = 1; page <= himalayasMaxPagesPerQuery; page++) {
        const url = `${BASE}?q=${encodeURIComponent(q)}&sort=recent&page=${page}`;
        // Only the very first request is conditional: the dataset refreshes as a whole.
        const first = qi === 0 && page === 1;
        const result = await ctx.fetcher.fetch(
          { url, allowedHosts: ctx.policy.allowedHosts, expect: 'json', validators: first ? ctx.validators : undefined },
          async (res) => ({ body: JSON.parse(await res.text()) as unknown, validators: validatorsFrom(res.headers) }),
        );
        if (result.kind === 'not-modified') {
          if (first) return { kind: 'unchanged', validators: ctx.validators };
          break;
        }
        if (first) validators = result.value.validators;
        const items = obj(result.value.body)?.jobs;
        if (!Array.isArray(items)) throw new Error('Himalayas response has no jobs array');
        seen += items.length;
        const parsed = parseItems(items, parseHimalayasJob);
        malformed += parsed.malformed;
        for (const job of parsed.jobs) byId.set(job.sourceJobId, job);
        // Results are newest first: stop paging once we pass the window.
        const reachedOld = parsed.jobs.some((j) => publishedBefore(j.publishedAt, ctx.sinceMs));
        if (items.length < PAGE_SIZE || reachedOld) break;
      }
    }
    return { kind: 'ok', jobs: [...byId.values()], validators, malformed, seen };
  },
};
