import { jobicyMaxPages, jobicyQuery } from '../../config/sources';
import { validatorsFrom } from '../scraping/http-client';
import { parsePeriod } from '../core/salary';
import type { AdapterContext, ExternalJob, FetchResult, SourceAdapter, Validators } from './contract';
import { isoOrUndefined, num, obj, parseItems, publishedBefore, str, strArray } from './parse-utils';

/**
 * Jobicy public API (verified 2026-11-10): GET https://jobicy.com/api/jobs with `count`,
 * `industry`, and `cursor` (follow sequentially, same filters). `pubDate` is ISO 8601.
 * Fair use: no automated sync pass more often than hourly (enforced by minIntervalMinutes).
 * Attribution: credit Jobicy and keep the canonical Jobicy URL.
 */
const BASE = 'https://jobicy.com/api/jobs';

export function parseJobicyJob(item: unknown): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  const id = str(j.id);
  const title = str(j.jobTitle);
  const url = str(j.url);
  if (!id || !title || !url) return undefined;
  const geo = str(j.jobGeo);
  const level = str(j.jobLevel);
  const min = num(j.salaryMin);
  const max = num(j.salaryMax);
  return {
    sourceId: 'jobicy',
    sourceJobId: id,
    title,
    company: str(j.companyName) ?? 'Unknown company',
    location: geo ? `Remote - ${geo}` : 'Remote',
    locationRestrictions: geo ? geo.split(/,\s*/) : undefined,
    remote: true,
    description: str(j.jobDescription) ?? str(j.jobExcerpt),
    descriptionIsHtml: true,
    tags: [...strArray(j.jobIndustry), ...strArray(j.jobType)],
    seniorityHints: level && level.toLowerCase() !== 'any' ? [level] : [],
    applyUrl: url,
    sourceUrl: url,
    publishedAt: isoOrUndefined(j.pubDate),
    salary:
      min !== undefined || max !== undefined
        ? { min, max, currency: str(j.salaryCurrency), period: parsePeriod(str(j.salaryPeriod)) ?? 'year', origin: 'Jobicy' }
        : undefined,
    via: 'Jobicy',
  };
}

export const jobicyAdapter: SourceAdapter = {
  id: 'jobicy',
  async fetch(ctx: AdapterContext): Promise<FetchResult> {
    const jobs: ExternalJob[] = [];
    let malformed = 0;
    let seen = 0;
    let validators: Validators = {};
    let cursor: string | undefined;

    for (let page = 0; page < jobicyMaxPages; page++) {
      const params = new URLSearchParams({ count: String(jobicyQuery.count), industry: jobicyQuery.industry });
      if (cursor) params.set('cursor', cursor);
      const result = await ctx.fetcher.fetch(
        { url: `${BASE}?${params}`, allowedHosts: ctx.policy.allowedHosts, expect: 'json', validators: page === 0 ? ctx.validators : undefined },
        async (res) => ({ body: JSON.parse(await res.text()) as unknown, validators: validatorsFrom(res.headers) }),
      );
      if (result.kind === 'not-modified') {
        if (page === 0) return { kind: 'unchanged', validators: ctx.validators };
        break;
      }
      if (page === 0) validators = result.value.validators;
      const body = obj(result.value.body);
      const items = body?.jobs;
      if (!Array.isArray(items)) throw new Error('Jobicy response has no jobs array');
      seen += items.length;
      const parsed = parseItems(items, parseJobicyJob);
      malformed += parsed.malformed;
      jobs.push(...parsed.jobs);
      cursor = str(body?.nextCursor);
      const reachedOld = parsed.jobs.some((j) => publishedBefore(j.publishedAt, ctx.sinceMs));
      if (!cursor || body?.hasMore !== true || reachedOld) break;
    }
    return { kind: 'ok', jobs, validators, malformed, seen };
  },
};
