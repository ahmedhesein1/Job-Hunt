import type { ExternalJob } from '../contract';
import { isoOrUndefined, obj, str } from '../parse-utils';
import type { BoardRef } from './common';

/**
 * Greenhouse Job Board API (verified 2026-11-10):
 * GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true → {jobs, meta}.
 * `content` is entity-encoded HTML; dates are ISO with offset. Only published jobs are
 * returned by this public endpoint. No pagination.
 */
export function greenhouseUrl(board: BoardRef): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs?content=true`;
}

export function parseGreenhouseJob(item: unknown, board: BoardRef): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  const id = str(j.id);
  const title = str(j.title);
  const url = str(j.absolute_url);
  if (!id || !title || !url) return undefined;
  const location = str(obj(j.location)?.name);
  return {
    sourceId: 'company-boards',
    sourceJobId: `greenhouse:${board.token}:${id}`,
    title,
    company: board.company ?? str(j.company_name) ?? board.token,
    location,
    remote: location && /\bremote\b/i.test(location) ? true : undefined,
    description: str(j.content),
    descriptionIsHtml: true,
    applyUrl: url,
    sourceUrl: url,
    employerUrl: url,
    publishedAt: isoOrUndefined(j.first_published) ?? isoOrUndefined(j.updated_at),
    requisitionId: str(j.requisition_id),
    via: 'Greenhouse',
  };
}

export function greenhouseItems(body: unknown): unknown[] | undefined {
  const jobs = obj(body)?.jobs;
  return Array.isArray(jobs) ? jobs : undefined;
}
