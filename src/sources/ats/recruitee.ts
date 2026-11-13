import { parsePeriod } from '../../core/salary';
import type { ExternalJob } from '../contract';
import { num, obj, str } from '../parse-utils';
import type { BoardRef } from './common';

/**
 * Recruitee Careers Site API (verified 2026-11-11): GET https://{company}.recruitee.com/api/offers/
 * → {offers[]}. Dates are "YYYY-MM-DD HH:MM:SS UTC" (not ISO).
 * NOTE: from 2027-02-10 Recruitee requires a per-company X-Careers-Sites-Token; keyless
 * calls will return 401 and the board pauses for review.
 */
export function recruiteeUrl(board: BoardRef): string {
  return `https://${board.token}.recruitee.com/api/offers/`;
}

export function recruiteeItems(body: unknown): unknown[] | undefined {
  const offers = obj(body)?.offers;
  return Array.isArray(offers) ? offers : undefined;
}

/** "2026-07-10 13:18:00 UTC" → ISO. */
export function recruiteeDate(value: unknown): string | undefined {
  const s = str(value);
  const m = s && /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(s);
  return m ? new Date(`${m[1]}T${m[2]}Z`).toISOString() : undefined;
}

export function parseRecruiteeJob(item: unknown, board: BoardRef): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  if (str(j.status) && str(j.status) !== 'published') return undefined;
  const slug = str(j.slug);
  const title = str(j.title);
  if (!slug || !title) return undefined;
  const url = str(j.careers_url) ?? `https://${board.token}.recruitee.com/o/${slug}`;
  const places = (Array.isArray(j.locations) ? j.locations : [])
    .map((l) => [str(obj(l)?.city), str(obj(l)?.country)].filter(Boolean).join(', '))
    .filter(Boolean);
  const salary = obj(j.salary);
  const min = num(salary?.min);
  const max = num(salary?.max);
  return {
    sourceId: 'company-boards',
    sourceJobId: `recruitee:${board.token}:${str(j.id) ?? slug}`,
    title,
    company: board.company ?? str(j.company_name) ?? board.token,
    location: [str(j.location), ...places].filter(Boolean).join('; ') || undefined,
    countryCode: places.length <= 1 ? str(j.country_code)?.toUpperCase() : undefined,
    remote: j.remote === true ? true : j.on_site === true || j.hybrid === true ? false : undefined,
    description: [str(j.description), str(j.requirements)].filter(Boolean).join('\n') || undefined,
    descriptionIsHtml: true,
    seniorityHints: str(j.experience_code) ? [String(j.experience_code).replace(/_/g, ' ')] : [],
    applyUrl: url,
    sourceUrl: url,
    employerUrl: url,
    publishedAt: recruiteeDate(j.published_at) ?? recruiteeDate(j.created_at),
    salary: min !== undefined || max !== undefined ? { min, max, currency: str(salary?.currency), period: parsePeriod(str(salary?.period)) ?? 'year', origin: 'employer' } : undefined,
    via: 'Recruitee',
  };
}
