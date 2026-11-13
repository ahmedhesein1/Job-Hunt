import type { ExternalJob } from '../contract';
import { isoOrUndefined, obj, str } from '../parse-utils';
import type { BoardRef } from './common';

/**
 * Workable public jobs API (verified 2026-11-11, workable.readme.io "jobs-1", no auth):
 * GET https://www.workable.com/api/accounts/{subdomain}?details=true → 302 to
 * apply.workable.com/api/v1/widget/accounts/{subdomain}. Returns {name, description, jobs[]}
 * with ONE ROW PER LOCATION — rows are merged by `shortcode`. Dates are YYYY-MM-DD.
 */
export function workableUrl(board: BoardRef): string {
  return `https://www.workable.com/api/accounts/${encodeURIComponent(board.token)}?details=true`;
}

export function workableItems(body: unknown): unknown[] | undefined {
  const o = obj(body);
  const jobs = o?.jobs;
  if (!Array.isArray(jobs)) return undefined;
  // Merge per-location rows into one posting per shortcode.
  const byCode = new Map<string, Record<string, unknown>>();
  for (const row of jobs) {
    const r = obj(row);
    const code = str(r?.shortcode);
    if (!r || !code) continue;
    const existing = byCode.get(code);
    const locs = Array.isArray(r.locations) ? r.locations : [];
    if (existing) existing.locations = [...(existing.locations as unknown[]), ...locs];
    else byCode.set(code, { ...r, locations: [...locs], __company: str(o?.name) });
  }
  return [...byCode.values()];
}

export function parseWorkableJob(item: unknown, board: BoardRef): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  const code = str(j.shortcode);
  const title = str(j.title);
  if (!code || !title) return undefined;
  const url = `https://apply.workable.com/${board.token}/j/${code}`;
  const places = (Array.isArray(j.locations) ? j.locations : [])
    .map(obj)
    .filter((l): l is Record<string, unknown> => Boolean(l) && l?.hidden !== true)
    .map((l) => [str(l.city), str(l.region), str(l.country)].filter(Boolean).join(', '))
    .filter(Boolean);
  const countryCodes = new Set(
    (Array.isArray(j.locations) ? j.locations : []).map((l) => str(obj(l)?.countryCode)?.toUpperCase()).filter(Boolean),
  );
  const experience = str(j.experience);
  return {
    sourceId: 'company-boards',
    sourceJobId: `workable:${board.token}:${code}`,
    title,
    company: board.company ?? str(j.__company) ?? board.token,
    location: [...new Set(places)].join('; ') || [str(j.city), str(j.country)].filter(Boolean).join(', ') || undefined,
    // A single country is reliable on-site evidence; several countries are not.
    countryCode: countryCodes.size === 1 ? [...countryCodes][0] : undefined,
    remote: j.telecommuting === true ? true : undefined,
    description: str(j.description),
    descriptionIsHtml: true,
    seniorityHints: experience ? [experience] : [],
    applyUrl: url,
    sourceUrl: url,
    employerUrl: url,
    publishedAt: isoOrUndefined(j.published_on) ?? isoOrUndefined(j.created_at),
    requisitionId: str(j.code),
    via: 'Workable',
  };
}
