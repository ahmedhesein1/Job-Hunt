import { decodeEntities } from '../core/normalize';
import { parsePeriod } from '../core/salary';
import type { ExternalJob, RawSalary } from './contract';
import { isoOrUndefined, num, obj, str } from './parse-utils';

/**
 * schema.org JobPosting extraction from career-page HTML. Employers publish this
 * structured data for Google Jobs, so one parser covers most custom career sites without
 * brittle per-site selectors. Spec: https://schema.org/JobPosting.
 */
const LD_SCRIPT = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isJobPosting(node: Record<string, unknown>): boolean {
  return asArray(node['@type']).some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
}

/** Every JobPosting node in the page, including inside @graph and arrays. */
export function extractJobPostings(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 5) return;
    for (const item of asArray(node)) {
      const o = obj(item);
      if (!o) continue;
      if (isJobPosting(o)) out.push(o);
      if (o['@graph']) visit(o['@graph'], depth + 1);
    }
  };
  for (const match of html.matchAll(LD_SCRIPT)) {
    const raw = (match[1] ?? '').trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try {
      visit(JSON.parse(raw), 0);
    } catch {
      // Some sites emit invalid JSON-LD (e.g. raw newlines inside strings); try once more.
      try {
        visit(JSON.parse(raw.replace(/[\r\n\t]+/g, ' ')), 0);
      } catch {
        /* not parseable: ignored, other blocks may still work */
      }
    }
  }
  return out;
}

function placeName(value: unknown): string | undefined {
  const s = str(value);
  if (s) return s;
  const o = obj(value);
  return str(o?.name) ?? str(o?.addressCountry) ?? undefined;
}

function locationText(jobLocation: unknown): { text?: string | undefined; countryCode?: string | undefined } {
  const parts: string[] = [];
  let countryCode: string | undefined;
  for (const place of asArray(jobLocation)) {
    const address = obj(obj(place)?.address) ?? obj(place);
    if (!address) continue;
    const country = placeName(address.addressCountry);
    if (country && /^[A-Z]{2}$/.test(country)) countryCode ??= country;
    const piece = [str(address.addressLocality), str(address.addressRegion), country].filter(Boolean).join(', ');
    if (piece) parts.push(piece);
  }
  return { text: parts.length ? [...new Set(parts)].join('; ') : undefined, countryCode };
}

function salaryFrom(base: unknown): RawSalary | undefined {
  const amount = obj(base);
  if (!amount) return undefined;
  const value = obj(amount.value);
  const min = num(value?.minValue) ?? num(value?.value) ?? num(amount.value);
  const max = num(value?.maxValue) ?? num(value?.value);
  if (min === undefined && max === undefined) return undefined;
  return { min, max, currency: str(amount.currency), period: parsePeriod(str(value?.unitText)) ?? 'year', origin: 'employer' };
}

export interface JsonLdContext {
  sourceId: ExternalJob['sourceId'];
  pageUrl: string;
  /** Company name override from configuration. */
  company?: string | undefined;
  via: string;
}

export function jobFromJsonLd(node: Record<string, unknown>, ctx: JsonLdContext, nowMs: number): ExternalJob | undefined {
  const title = str(node.title) ?? str(node.name);
  if (!title) return undefined;
  const validThrough = isoOrUndefined(node.validThrough);
  // Expired postings are not jobs anymore.
  if (validThrough && Date.parse(validThrough) < nowMs) return undefined;
  const url = str(node.url) ?? ctx.pageUrl;
  const identifier = str(node.identifier) ?? str(obj(node.identifier)?.value);
  const location = locationText(node.jobLocation);
  const remote = asArray(node.jobLocationType).some((t) => String(t).toUpperCase() === 'TELECOMMUTE') ? true : undefined;
  const restrictions = asArray(node.applicantLocationRequirements).map(placeName).filter((v): v is string => Boolean(v));
  const months = num(obj(node.experienceRequirements)?.monthsOfExperience);
  const description = str(node.description);
  return {
    sourceId: ctx.sourceId,
    sourceJobId: identifier ? `${new URL(ctx.pageUrl).hostname}:${identifier}` : url,
    title: decodeEntities(title),
    company: ctx.company ?? placeName(node.hiringOrganization) ?? new URL(ctx.pageUrl).hostname,
    location: location.text ?? (remote ? 'Remote' : undefined),
    countryCode: location.countryCode,
    locationRestrictions: restrictions.length ? restrictions : undefined,
    remote,
    // Months of experience are appended so the years-of-experience rule can read them.
    description: [description ? decodeEntities(description) : '', months ? `<p>${Math.ceil(months / 12)}+ years of experience</p>` : ''].join('') || undefined,
    descriptionIsHtml: true,
    applyUrl: url,
    sourceUrl: url,
    employerUrl: url,
    publishedAt: isoOrUndefined(node.datePosted),
    salary: salaryFrom(node.baseSalary),
    requisitionId: identifier,
    via: ctx.via,
  };
}
