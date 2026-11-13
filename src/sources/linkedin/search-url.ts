import type { DatePosted, EmploymentType, ExperienceLevel, LinkedInSearch, Workplace } from '../../../config/linkedin-searches';

/**
 * Builds LinkedIn job-search URLs for the owner to open in their own browser. Nothing in
 * this project fetches these URLs.
 *
 * Parameter values follow LinkedIn's public search URLs: f_TPR (seconds since posting),
 * f_E (experience), f_JT (job type), f_WT (workplace), f_AL (Easy Apply), sortBy=DD.
 */
const BASE = 'https://www.linkedin.com/jobs/search';
/** Cards per results page. */
export const LINKEDIN_PAGE_SIZE = 25;
/** LinkedIn stops paginating at 1,000 results. */
const MAX_PAGE = 39;

const DATE_POSTED: Record<Exclude<DatePosted, 'any'>, string> = {
  'past-hour': 'r3600',
  'past-24h': 'r86400',
  'past-week': 'r604800',
  'past-month': 'r2592000',
};
const EXPERIENCE: Record<ExperienceLevel, string> = {
  internship: '1',
  entry: '2',
  associate: '3',
  'mid-senior': '4',
  director: '5',
  executive: '6',
};
const EMPLOYMENT: Record<EmploymentType, string> = {
  'full-time': 'F',
  'part-time': 'P',
  contract: 'C',
  temporary: 'T',
  internship: 'I',
  volunteer: 'V',
  other: 'O',
};
const WORKPLACE: Record<Workplace, string> = { 'on-site': '1', remote: '2', hybrid: '3' };

export class InvalidSearchError extends Error {
  override name = 'InvalidSearchError';
}

function codes<K extends string>(values: readonly K[] | undefined, table: Record<K, string>): string | undefined {
  if (!values || values.length === 0) return undefined;
  return [...new Set(values.map((v) => table[v]))].join(',');
}

const MAX_KEYWORDS_CHARS = 500;
const MAX_LABEL_CHARS = 40;

/**
 * Normalises a Boolean keyword query and rejects ones LinkedIn would misread: curly
 * quotes become straight quotes, whitespace collapses, quotes and parentheses must balance.
 */
export function normalizeKeywords(raw: string, id = 'search'): string {
  const keywords = raw.replace(/[“”„]/g, '"').replace(/\s+/g, ' ').trim();
  if (!keywords) throw new InvalidSearchError(`search ${id}: keywords are required`);
  if (keywords.length > MAX_KEYWORDS_CHARS) throw new InvalidSearchError(`search ${id}: keywords longer than ${MAX_KEYWORDS_CHARS} characters`);
  if ((keywords.match(/"/g) ?? []).length % 2 !== 0) throw new InvalidSearchError(`search ${id}: unbalanced quotes`);
  let depth = 0;
  // Parentheses inside "quoted phrases" are literal text.
  for (const ch of keywords.replace(/"[^"]*"/g, '')) {
    if (ch === '(') depth += 1;
    if (ch === ')' && --depth < 0) break;
  }
  if (depth !== 0) throw new InvalidSearchError(`search ${id}: unbalanced parentheses`);
  return keywords;
}

/** URL for one results page (`page` is 0-based). */
export function buildLinkedInSearchUrl(search: LinkedInSearch, page = 0): string {
  const keywords = normalizeKeywords(search.keywords, search.id);
  if (search.geoId !== undefined && !/^\d+$/.test(search.geoId)) throw new InvalidSearchError(`search ${search.id}: geoId must be numeric`);
  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE) throw new InvalidSearchError(`page must be an integer from 0 to ${MAX_PAGE}`);

  const params = new URLSearchParams({ keywords });
  const location = search.location?.trim();
  if (location) params.set('location', location);
  if (search.geoId) params.set('geoId', search.geoId);
  if (search.datePosted && search.datePosted !== 'any') {
    params.set('f_TPR', DATE_POSTED[search.datePosted]);
    params.set('activeFilter', 'f_TPR');
  }
  const optional: Array<[string, string | undefined]> = [
    ['f_E', codes(search.experience, EXPERIENCE)],
    ['f_JT', codes(search.employmentTypes, EMPLOYMENT)],
    ['f_WT', codes(search.workplace, WORKPLACE)],
    ['f_AL', search.easyApplyOnly ? 'true' : undefined],
    ['sortBy', search.sortByDate ? 'DD' : undefined],
  ];
  for (const [key, value] of optional) if (value) params.set(key, value);
  params.set('position', '1');
  params.set('pageNum', String(page));
  if (page > 0) params.set('start', String(page * LINKEDIN_PAGE_SIZE));
  return `${BASE}?${params.toString()}`;
}

/** Checks every saved search once (used at startup of the command and in tests). */
export function validateSearches(searches: readonly LinkedInSearch[]): void {
  const ids = new Set<string>();
  for (const s of searches) {
    if (ids.has(s.id)) throw new InvalidSearchError(`duplicate search id: ${s.id}`);
    ids.add(s.id);
    const label = s.label.trim();
    if (!label || [...label].length > MAX_LABEL_CHARS) throw new InvalidSearchError(`search ${s.id}: label must be 1–${MAX_LABEL_CHARS} characters`);
    buildLinkedInSearchUrl(s);
  }
}
