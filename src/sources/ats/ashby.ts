import { parsePeriod } from '../../core/salary';
import type { ExternalJob, RawSalary } from '../contract';
import { isoOrUndefined, num, obj, str } from '../parse-utils';
import type { BoardRef } from './common';

/**
 * Ashby public Job Postings API (verified 2026-11-10):
 * GET https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true →
 * {apiVersion, jobs}. Compensation is per job (`jobs[].compensation`), and
 * `addressCountry` is a country *name*. Unlisted jobs (`isListed: false`) are skipped.
 */
export function ashbyUrl(board: BoardRef): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token)}?includeCompensation=true`;
}

function salaryFrom(compensation: Record<string, unknown> | undefined): RawSalary | undefined {
  const tiers = compensation?.compensationTiers;
  const summary = compensation?.summaryComponents;
  const components = [
    ...(Array.isArray(summary) ? summary : []),
    ...(Array.isArray(tiers) ? tiers.flatMap((t) => (Array.isArray(obj(t)?.components) ? (obj(t)?.components as unknown[]) : [])) : []),
  ]
    .map(obj)
    .filter((c): c is Record<string, unknown> => Boolean(c));
  const salary = components.find((c) => str(c.compensationType)?.toLowerCase() === 'salary');
  if (!salary) return undefined;
  return {
    min: num(salary.minValue),
    max: num(salary.maxValue),
    currency: str(salary.currencyCode),
    period: parsePeriod(str(salary.interval)) ?? 'year',
    origin: 'employer',
  };
}

export function parseAshbyJob(item: unknown, board: BoardRef): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  if (j.isListed === false) return undefined;
  const id = str(j.id);
  const title = str(j.title);
  const jobUrl = str(j.jobUrl);
  if (!id || !title || !jobUrl) return undefined;
  const country = str(obj(obj(j.address)?.postalAddress)?.addressCountry);
  const secondary = Array.isArray(j.secondaryLocations) ? j.secondaryLocations.map((l) => str(obj(l)?.location)).filter(Boolean) : [];
  const primary = str(j.location);
  const location = [primary, ...secondary].filter(Boolean).join('; ') || country;
  const workplace = str(j.workplaceType)?.toLowerCase();
  return {
    sourceId: 'company-boards',
    sourceJobId: `ashby:${board.token}:${id}`,
    title,
    company: board.company ?? board.token,
    location,
    remote: j.isRemote === true || workplace === 'remote' ? true : workplace === 'onsite' || workplace === 'hybrid' ? false : undefined,
    description: str(j.descriptionHtml) ?? str(j.descriptionPlain),
    descriptionIsHtml: Boolean(str(j.descriptionHtml)),
    applyUrl: jobUrl,
    sourceUrl: jobUrl,
    employerUrl: jobUrl,
    publishedAt: isoOrUndefined(j.publishedAt),
    salary: salaryFrom(obj(j.compensation)),
    via: 'Ashby',
  };
}

export function ashbyItems(body: unknown): unknown[] | undefined {
  const jobs = obj(body)?.jobs;
  return Array.isArray(jobs) ? jobs : undefined;
}
