import type { SearchProfile } from '../../config/profiles';
import type { SourceId } from '../../config/sources';
import type { ExternalJob } from '../sources/contract';
import { evaluateEligibility, type EligibilityStatus } from './eligibility';
import { normalizeSalary, type NormalizedSalary } from './salary';
import { classifySeniority, extractMinYears } from './seniority';
import type { Seniority } from '../../config/profiles';
import { extractSkills, normalizeForMatch } from './skills';
import { canonicalizeUrl, stableId } from './url';
import { companyKey, fingerprint } from './dedupe';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', euro: '€', pound: '£', copy: '©',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** HTML → plain text. Handles entity-encoded HTML (Greenhouse `content`). */
export function htmlToText(html: string): string {
  let source = html;
  // Greenhouse returns "&lt;div&gt;…": decode once so tags become real tags.
  if (!/<[a-z!/]/i.test(source) && /&lt;\/?[a-z]/i.test(source)) source = decodeEntities(source);
  const text = source
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|section)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Repairs UTF-8 text that was decoded as Latin-1 (seen in Remote OK: "MÃ©xico"). */
export function repairMojibake(text: string): string {
  if (!/[ÃÂâ][\u0080-¿]/.test(text)) return text;
  const repaired = Buffer.from(text, 'latin1').toString('utf8');
  return repaired.includes('�') ? text : repaired;
}

export function cleanText(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const cleaned = repairMojibake(decodeEntities(String(value))).replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

export interface NormalizedJob {
  jobId: string;
  sourceId: SourceId;
  sourceJobId: string;
  title: string;
  company: string;
  companyKey: string;
  location?: string | undefined;
  remoteScope: string;
  eligibility: EligibilityStatus;
  eligibilityReason?: string | undefined;
  eligibleRegions: string[];
  skills: string[];
  seniority?: Seniority | undefined;
  clearlySenior: boolean;
  /** Leadership / people-management title (always rejected). */
  leadership: boolean;
  minYears?: number | undefined;
  salary?: NormalizedSalary | undefined;
  applyUrl: string;
  sourceUrl: string;
  canonicalUrl?: string | undefined;
  employerUrl?: string | undefined;
  fingerprint: string;
  publishedAt?: string | undefined;
  publishedAtReliable: boolean;
  discoveredAt: string;
  /** Short plain-text summary stored with the job (never the full description). */
  summary?: string | undefined;
  /** Normalised description text used for matching only; not persisted. */
  matchText: string;
  /** True when a description long enough to judge skills was available. */
  hasDescription: boolean;
  tags: string[];
  requisitionId?: string | undefined;
  via?: string | undefined;
  matchedSearches?: string[] | undefined;
  employmentType?: string | undefined;
  experienceLevel?: string | undefined;
}

const SUMMARY_CHARS = 280;
/** Below this many characters a description is a snippet, not evidence (§6.2). */
export const MIN_DESCRIPTION_CHARS = 300;

function parsePublishedAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function normalizeJob(
  external: ExternalJob,
  profile: SearchProfile,
  nowMs: number,
): NormalizedJob {
  const title = cleanText(external.title) ?? '';
  const company = cleanText(external.company) ?? 'Unknown company';
  const location = cleanText(external.location);
  const descriptionText = external.description
    ? repairMojibake(external.descriptionIsHtml === false ? external.description : htmlToText(external.description))
    : '';
  const tags = (external.tags ?? []).map((t) => normalizeForMatch(cleanText(t) ?? '')).filter(Boolean);
  const matchText = normalizeForMatch(`${title}\n${descriptionText}`);
  const hasDescription = descriptionText.length >= MIN_DESCRIPTION_CHARS;

  const eligibility = evaluateEligibility(
    {
      title,
      location,
      locationRestrictions: external.locationRestrictions?.map((r) => cleanText(r) ?? '').filter(Boolean),
      countryCode: external.countryCode,
      remote: external.remote,
      description: descriptionText,
      tags,
      timezoneOffsets: external.timezoneOffsets,
    },
    profile,
    nowMs,
  );
  const seniority = classifySeniority(title, external.seniorityHints ?? []);
  const canonicalUrl = canonicalizeUrl(external.employerUrl ?? external.applyUrl) ?? canonicalizeUrl(external.sourceUrl);
  const ck = companyKey(company);

  return {
    jobId: stableId(external.sourceId, external.sourceJobId),
    sourceId: external.sourceId,
    sourceJobId: external.sourceJobId,
    title,
    company,
    companyKey: ck,
    location,
    remoteScope: eligibility.remoteScope,
    eligibility: eligibility.status,
    eligibilityReason: eligibility.reason,
    eligibleRegions: eligibility.eligibleRegions,
    skills: [...extractSkills(matchText, tags)].sort(),
    seniority: seniority.level,
    clearlySenior: seniority.clearlySenior,
    leadership: seniority.leadership,
    minYears: extractMinYears(descriptionText),
    salary: normalizeSalary(external.salary),
    applyUrl: external.applyUrl,
    sourceUrl: external.sourceUrl,
    canonicalUrl,
    employerUrl: external.employerUrl,
    fingerprint: fingerprint(company, title, eligibility.remoteScope),
    publishedAt: parsePublishedAt(external.publishedAt),
    publishedAtReliable: external.publishedAtReliable ?? true,
    discoveredAt: new Date(nowMs).toISOString(),
    summary: descriptionText ? descriptionText.slice(0, SUMMARY_CHARS).replace(/\s+/g, ' ').trim() : undefined,
    matchText,
    hasDescription,
    tags,
    requisitionId: cleanText(external.requisitionId),
    via: external.via,
    matchedSearches: external.matchedSearches,
    employmentType: cleanText(external.employmentType),
    experienceLevel: cleanText(external.experienceLevel) ?? (seniority.level ? String(seniority.level) : undefined),
  };
}

/** Sanity guard used by adapters (§8 step 7): a job needs a title and a URL. */
export function isUsable(job: ExternalJob): boolean {
  return Boolean(job.title?.trim() && job.applyUrl && job.sourceUrl && job.sourceJobId) && job.title.length < 500;
}

