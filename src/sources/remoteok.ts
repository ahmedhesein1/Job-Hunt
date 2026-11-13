import { validatorsFrom } from '../scraping/http-client';
import type { AdapterContext, ExternalJob, FetchResult, SourceAdapter } from './contract';
import { epochSecondsToIso, isoOrUndefined, num, obj, parseItems, str, strArray } from './parse-utils';

/**
 * Remote OK public JSON API (verified 2026-11-10): GET https://remoteok.com/api returns an
 * array whose first element is a legal notice. `epoch` is seconds; salary 0 = unknown.
 * Attribution: mention Remote OK and link (follow) to the Remote OK listing URL.
 */
const URL_API = 'https://remoteok.com/api';

export function parseRemoteOkJob(item: unknown): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  const id = str(j.id);
  const title = str(j.position);
  const url = str(j.url) ?? str(j.apply_url);
  if (!id || !title || !url) return undefined;
  const listing = url.replace(/^https:\/\/remoteOK\.com/i, 'https://remoteok.com');
  const min = num(j.salary_min);
  const max = num(j.salary_max);
  return {
    sourceId: 'remoteok',
    sourceJobId: id,
    title,
    company: str(j.company) ?? 'Unknown company',
    location: str(j.location) ?? 'Remote',
    remote: true,
    description: str(j.description),
    descriptionIsHtml: true,
    tags: strArray(j.tags),
    applyUrl: listing,
    sourceUrl: listing,
    publishedAt: epochSecondsToIso(j.epoch) ?? isoOrUndefined(j.date),
    salary: (min ?? 0) > 0 || (max ?? 0) > 0 ? { min: min || undefined, max: max || undefined, currency: 'USD', period: 'year', origin: 'Remote OK' } : undefined,
    via: 'Remote OK',
  };
}

export const remoteOkAdapter: SourceAdapter = {
  id: 'remoteok',
  async fetch(ctx: AdapterContext): Promise<FetchResult> {
    const result = await ctx.fetcher.fetch(
      { url: URL_API, allowedHosts: ctx.policy.allowedHosts, expect: 'json', validators: ctx.validators },
      async (res) => ({ body: JSON.parse(await res.text()) as unknown, validators: validatorsFrom(res.headers) }),
    );
    if (result.kind === 'not-modified') return { kind: 'unchanged', validators: ctx.validators };
    const body = result.value.body;
    if (!Array.isArray(body)) throw new Error('Remote OK response is not an array');
    // Skip the legal-notice element (it has no id).
    const items = body.filter((e) => obj(e)?.id !== undefined);
    const parsed = parseItems(items, parseRemoteOkJob);
    return { kind: 'ok', jobs: parsed.jobs, validators: result.value.validators, malformed: parsed.malformed, seen: items.length };
  },
};
