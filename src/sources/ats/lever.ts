import { parsePeriod } from '../../core/salary';
import type { ExternalJob } from '../contract';
import { epochMsToIso, num, obj, str, strArray } from '../parse-utils';
import type { BoardRef } from './common';

/**
 * Lever Postings API (verified 2026-11-10):
 * GET https://api.lever.co/v0/postings/{site}?mode=json (EU: api.eu.lever.co) → array.
 * `createdAt` is epoch **milliseconds**; `workplaceType` is onsite|on-site|remote|hybrid|unspecified.
 * Content may live entirely in `lists`, so description is assembled from all parts.
 */
export function leverUrl(board: BoardRef): string {
  const host = board.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  return `https://${host}/v0/postings/${encodeURIComponent(board.token)}?mode=json`;
}

function remoteFrom(workplaceType: string | undefined, location: string | undefined): boolean | undefined {
  switch (workplaceType?.toLowerCase()) {
    case 'remote':
      return true;
    case 'onsite':
    case 'on-site':
    case 'hybrid':
      return false;
    default:
      return location && /\bremote\b/i.test(location) ? true : undefined;
  }
}

export function parseLeverJob(item: unknown, board: BoardRef): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  const id = str(j.id);
  const title = str(j.text);
  const hostedUrl = str(j.hostedUrl);
  if (!id || !title || !hostedUrl) return undefined;
  const categories = obj(j.categories);
  const allLocations = strArray(categories?.allLocations);
  const location = allLocations.length > 0 ? allLocations.join('; ') : str(categories?.location);
  const lists = Array.isArray(j.lists)
    ? j.lists.map((l) => `<h3>${str(obj(l)?.text) ?? ''}</h3><ul>${str(obj(l)?.content) ?? ''}</ul>`).join('')
    : '';
  const description = [str(j.description), lists, str(j.additional)].filter(Boolean).join('\n');
  const salary = obj(j.salaryRange);
  return {
    sourceId: 'company-boards',
    sourceJobId: `lever:${board.token}:${id}`,
    title,
    company: board.company ?? board.token,
    location,
    countryCode: str(j.country)?.toUpperCase(),
    remote: remoteFrom(str(j.workplaceType), location),
    description: description || undefined,
    descriptionIsHtml: true,
    seniorityHints: strArray([categories?.level].filter(Boolean)),
    applyUrl: hostedUrl,
    sourceUrl: hostedUrl,
    employerUrl: hostedUrl,
    publishedAt: epochMsToIso(j.createdAt),
    salary: salary
      ? { min: num(salary.min), max: num(salary.max), currency: str(salary.currency), period: parsePeriod(str(salary.interval)) ?? 'year', origin: 'employer' }
      : undefined,
    via: 'Lever',
  };
}

export function leverItems(body: unknown): unknown[] | undefined {
  return Array.isArray(body) ? body : undefined;
}
