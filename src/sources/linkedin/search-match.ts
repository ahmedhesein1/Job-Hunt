import { LINKEDIN_GEO, type DatePosted, type EmploymentType, type LinkedInSearch } from '../../../config/linkedin-searches';
import { countriesIn } from '../../core/eligibility';
import { classifySeniority } from '../../core/seniority';
import { containsTerm, normalizeForMatch } from '../../core/skills';
import { matchesBooleanQuery } from './boolean-query';

/** A LinkedIn job as stored by the pipeline (fields available in the status index). */
export interface LinkedInCandidate {
  sourceId: string;
  sourceJobId?: string | undefined;
  /** Stored job ID (present for jobs read from the table). */
  jobId?: string | undefined;
  title: string;
  company: string;
  /** Location label, e.g. "Cairo, Egypt" or "Remote (Worldwide)". */
  remoteScope: string;
  summary?: string | undefined;
  publishedAt?: string | undefined;
  discoveredAt: string;
  applyUrl: string;
  sourceUrl: string;
  countryCode?: string | undefined;
  seniority?: string | undefined;
  employmentType?: string | undefined;
  salary?: import('../contract').RawSalary | import('../../core/salary').NormalizedSalary | undefined;
  easyApply?: boolean | undefined;
}

/** Country names used as saved-search locations, mapped to eligibility country codes. */
const LOCATION_CODES: Record<string, string> = {
  egypt: 'EG',
  'saudi arabia': 'SA',
  'united arab emirates': 'AE',
  qatar: 'QA',
  kuwait: 'KW',
  bahrain: 'BH',
  oman: 'OM',
  jordan: 'JO',
  lebanon: 'LB',
  iraq: 'IQ',
  morocco: 'MA',
  tunisia: 'TN',
  algeria: 'DZ',
  libya: 'LY',
};

const DATE_WINDOW_MS: Record<Exclude<DatePosted, 'any'>, number> = {
  'past-hour': 3_600_000,
  'past-24h': 86_400_000,
  'past-week': 7 * 86_400_000,
  'past-month': 30 * 86_400_000,
};

export function isRemoteScope(scope: string): boolean {
  return containsTerm(normalizeForMatch(scope), 'remote') || containsTerm(normalizeForMatch(scope), 'عن بعد');
}

function locationMatches(search: LinkedInSearch, scope: string): boolean {
  if (search.geoId === LINKEDIN_GEO.worldwide || !search.location) return true;
  const code = LOCATION_CODES[normalizeForMatch(search.location)];
  if (code) return countriesIn(scope).includes(code);
  return containsTerm(normalizeForMatch(scope), search.location);
}

function experienceMatches(search: LinkedInSearch, title: string): boolean {
  const levels = search.experience;
  if (!levels || levels.length === 0) return true;
  const s = classifySeniority(title);
  if (s.leadership) return levels.includes('director') || levels.includes('executive');
  if (s.level === undefined) return true; // title states no level: LinkedIn's own level is unknown
  const allowed = new Set(levels.flatMap((l) => (l === 'internship' ? ['intern'] : l === 'entry' ? ['junior'] : l === 'associate' ? ['junior', 'mid'] : l === 'mid-senior' ? ['mid', 'senior'] : [])));
  return allowed.has(s.level);
}

/**
 * Applies one saved search to one job: Boolean keywords on title, company and summary,
 * location, workplace, date posted and experience. Employment type and Easy Apply are not
 * present in LinkedIn alert or page data, so they are not checked (reported per search).
 */
export function matchesSearch(job: LinkedInCandidate, search: LinkedInSearch, nowMs: number): boolean {
  if (!matchesBooleanQuery(search.keywords, `${job.title}\n${job.company}\n${job.summary ?? ''}`)) return false;
  if (!locationMatches(search, job.remoteScope)) return false;
  const workplace = search.workplace ?? [];
  if (workplace.length > 0) {
    const remote = isRemoteScope(job.remoteScope);
    const wantsRemote = workplace.includes('remote');
    const wantsOffice = workplace.includes('on-site') || workplace.includes('hybrid');
    if ((remote && !wantsRemote) || (!remote && !wantsOffice)) return false;
  }
  if (search.datePosted && search.datePosted !== 'any') {
    const at = Date.parse(job.publishedAt ?? job.discoveredAt);
    if (!Number.isFinite(at) || nowMs - at > DATE_WINDOW_MS[search.datePosted]) return false;
  }
  if (search.employmentTypes && search.employmentTypes.length > 0 && job.employmentType) {
    if (!search.employmentTypes.includes(job.employmentType as EmploymentType)) return false;
  }
  if (search.easyApplyOnly && job.easyApply !== undefined && !job.easyApply) {
    return false;
  }
  return experienceMatches(search, job.title);
}

/** What a scraped search-result card states about a job (search-page.ts LinkedInCard). */
export interface CardFacts {
  title: string;
  location?: string | undefined;
  workplace?: 'remote' | 'hybrid' | 'on-site' | undefined;
  postedAt?: string | undefined;
  postedAtPrecise: boolean;
}

/** Slack for a bare posting date (no time of day) against the date-posted window. */
const DATE_ONLY_SLACK_MS = 86_400_000;

/**
 * Re-applies a saved search's filters to a card LinkedIn returned for it, using only what
 * the card states: a filter the card says nothing about passes (LinkedIn applied it to
 * data the card does not show). Keywords are not re-checked: LinkedIn matches them against
 * the full description, which cards do not include.
 */
export function cardMatchesFilters(card: CardFacts, search: LinkedInSearch, nowMs: number): boolean {
  // Location: only a country search against a card that names a country.
  const code = search.geoId === LINKEDIN_GEO.worldwide || !search.location ? undefined : LOCATION_CODES[normalizeForMatch(search.location)];
  if (code && card.location) {
    const named = countriesIn(card.location);
    if (named.length > 0 && !named.includes(code)) return false;
  }
  const workplace = search.workplace ?? [];
  if (workplace.length > 0 && card.workplace && !workplace.includes(card.workplace)) return false;
  if (search.datePosted && search.datePosted !== 'any' && card.postedAt) {
    const at = Date.parse(card.postedAt);
    const slack = card.postedAtPrecise ? 0 : DATE_ONLY_SLACK_MS;
    if (Number.isFinite(at) && nowMs - at > DATE_WINDOW_MS[search.datePosted] + slack) return false;
  }
  return experienceMatches(search, card.title);
}

/** Search filters that cards never state, so only LinkedIn's own filtering applies. */
export function cardUncheckableFilters(search: LinkedInSearch): string[] {
  const out: string[] = [];
  if (search.employmentTypes?.length) out.push('employment type');
  if (search.easyApplyOnly) out.push('Easy Apply');
  return out;
}

/** Filters a saved search cannot apply to available data (or this candidate). */
export function uncheckedFilters(search: LinkedInSearch, candidate?: Partial<LinkedInCandidate>): string[] {
  const out: string[] = [];
  if (search.employmentTypes?.length && (!candidate || !candidate.employmentType)) out.push('employment type');
  if (search.easyApplyOnly && (!candidate || candidate.easyApply === undefined)) out.push('Easy Apply');
  return out;
}
