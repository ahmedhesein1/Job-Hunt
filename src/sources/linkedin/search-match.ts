import { LINKEDIN_GEO, type DatePosted, type LinkedInSearch } from '../../../config/linkedin-searches';
import { countriesIn } from '../../core/eligibility';
import { classifySeniority } from '../../core/seniority';
import { normalizeForMatch } from '../../core/skills';

/**
 * Re-checks the cards LinkedIn returns for a saved search against the search's own
 * filters, using only what a card states.
 */

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

function experienceMatches(search: LinkedInSearch, title: string): boolean {
  const levels = search.experience;
  if (!levels || levels.length === 0) return true;
  const s = classifySeniority(title);
  if (s.leadership) return levels.includes('director') || levels.includes('executive');
  if (s.level === undefined) return true; // title states no level: LinkedIn's own level is unknown
  const allowed = new Set(levels.flatMap((l) => (l === 'internship' ? ['intern'] : l === 'entry' ? ['junior'] : l === 'associate' ? ['junior', 'mid'] : l === 'mid-senior' ? ['mid', 'senior'] : [])));
  return allowed.has(s.level);
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
