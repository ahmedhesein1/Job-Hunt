import type { ExternalJob } from '../contract';
import { obj, str } from '../parse-utils';
import type { BoardRef } from './common';

/**
 * BambooHR public careers list (verified 2026-11-11 on instabug.bamboohr.com; robots.txt
 * allows all): GET https://{company}.bamboohr.com/careers/list → {meta:{totalCount}, result[]}.
 * Items carry id, jobOpeningName, departmentLabel, employmentStatusLabel,
 * location{city,state}, atsLocation{country,state,city}, isRemote (often null).
 * There is no date and no description: skills/experience stay UNKNOWN (§6.3).
 */
export function bamboohrUrl(board: BoardRef): string {
  return `https://${board.token}.bamboohr.com/careers/list`;
}

export function bamboohrItems(body: unknown): unknown[] | undefined {
  const result = obj(body)?.result;
  return Array.isArray(result) ? result : undefined;
}

export function parseBamboohrJob(item: unknown, board: BoardRef): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  const id = str(j.id);
  const title = str(j.jobOpeningName);
  if (!id || !title) return undefined;
  const url = `https://${board.token}.bamboohr.com/careers/${id}`;
  const loc = obj(j.location);
  const ats = obj(j.atsLocation);
  const location = [str(ats?.city) ?? str(loc?.city), str(ats?.state) ?? str(loc?.state), str(ats?.country)].filter(Boolean).join(', ');
  return {
    sourceId: 'company-boards',
    sourceJobId: `bamboohr:${board.token}:${id}`,
    title,
    company: board.company ?? board.token,
    location: location || undefined,
    remote: j.isRemote === true ? true : undefined,
    applyUrl: url,
    sourceUrl: url,
    employerUrl: url,
    // No publish date in the list: never treated as stale; dedupe prevents repeats.
    publishedAtReliable: false,
    via: 'BambooHR',
  };
}
