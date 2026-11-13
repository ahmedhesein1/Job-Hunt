/**
 * Saved LinkedIn job searches. `/linkedin` sends them
 * as buttons that open in the owner's own browser. A page saved from the browser can then
 * be sent to the bot as an .html file for parsing (see src/sources/linkedin/).
 *
 * Keywords use LinkedIn's Boolean search: AND / OR / NOT in capitals, "exact phrases" in
 * straight double quotes, and parentheses for grouping. One Boolean search covers what
 * would otherwise take several pages to save.
 *
 * Add a search by appending an entry; `id` must be unique and stable, `label` short
 * (it is a Telegram button).
 */
export type DatePosted = 'past-hour' | 'past-24h' | 'past-week' | 'past-month' | 'any';
export type ExperienceLevel = 'internship' | 'entry' | 'associate' | 'mid-senior' | 'director' | 'executive';
export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'temporary' | 'internship' | 'volunteer' | 'other';
export type Workplace = 'on-site' | 'remote' | 'hybrid';
export type SearchGroup = 'fresh' | 'egypt' | 'gulf' | 'mena' | 'remote';

export interface LinkedInSearch {
  id: string;
  /** Button label in Telegram (≤ 40 characters). */
  label: string;
  /** `/linkedin <group>` shows only that group. */
  group?: SearchGroup;
  keywords: string;
  /** Free-text location as typed into LinkedIn's location box (any language). */
  location?: string;
  /** LinkedIn geographic ID; more precise than `location` when both are given. */
  geoId?: string;
  datePosted?: DatePosted;
  experience?: ExperienceLevel[];
  employmentTypes?: EmploymentType[];
  workplace?: Workplace[];
  easyApplyOnly?: boolean;
  /** Most recent first instead of LinkedIn's relevance order. */
  sortByDate?: boolean;
}

export const SEARCH_GROUPS: Record<SearchGroup, string> = {
  fresh: '⚡ Newest (past hour)',
  egypt: '🇪🇬 Egypt',
  gulf: '🏙 Gulf (GCC)',
  mena: '🌙 MENA',
  remote: '🌍 Remote worldwide',
};

/** LinkedIn geographic IDs used below. */
export const LINKEDIN_GEO = { egypt: '106155005', worldwide: '92000000' } as const;

/** Terms that never fit the profile (mirrors config/profiles.ts titleExclude). */
const EXCLUDE = 'NOT (Frontend OR "Front-end" OR iOS OR Android OR Flutter OR "React Native" OR QA OR Sales)';
const NODE = '("Node.js" OR NodeJS OR NestJS OR "Express.js")';
const BACKEND = '(Backend OR "Back-end" OR "Back End" OR "Server-side")';
const FULL_STACK = '("Full Stack" OR "Full-Stack" OR Fullstack)';
const GENERIC = '("Software Engineer" OR "Software Developer" OR "Software Development Engineer" OR SDE OR Programmer OR "Product Engineer" OR "Platform Engineer" OR "API Engineer" OR "Web Developer")';
/** Every backend-related family in one query, for markets too small to split. */
// Generic titles only with Node/TypeScript: LinkedIn cards carry no description to check.
const ANY_BACKEND = `(${NODE} OR ${BACKEND} OR ${FULL_STACK} OR MERN OR (("Software Engineer" OR "Software Developer" OR Programmer OR SDE) AND (Node OR NestJS OR TypeScript))) ${EXCLUDE}`;

/**
 * Gulf and MENA countries by LinkedIn location text (LinkedIn resolves the name; numeric
 * geo IDs are only used where verified). All workplace types: on-site, hybrid, remote.
 */
const GULF: Array<[id: string, name: string, label: string, date: DatePosted]> = [
  ['saudi', 'Saudi Arabia', 'Saudi Arabia', 'past-24h'],
  ['uae', 'United Arab Emirates', 'UAE', 'past-24h'],
  ['qatar', 'Qatar', 'Qatar', 'past-week'],
  ['kuwait', 'Kuwait', 'Kuwait', 'past-week'],
  ['bahrain', 'Bahrain', 'Bahrain', 'past-week'],
  ['oman', 'Oman', 'Oman', 'past-week'],
];
const MENA: Array<[id: string, name: string, label: string, date: DatePosted]> = [
  ['jordan', 'Jordan', 'Jordan', 'past-week'],
  ['morocco', 'Morocco', 'Morocco', 'past-week'],
  ['tunisia', 'Tunisia', 'Tunisia', 'past-week'],
  ['lebanon', 'Lebanon', 'Lebanon', 'past-week'],
  ['iraq', 'Iraq', 'Iraq', 'past-week'],
  ['algeria', 'Algeria', 'Algeria', 'past-week'],
];
const age = (d: DatePosted) => (d === 'past-24h' ? '24 h' : 'week');
function countrySearches(group: SearchGroup, countries: typeof GULF): LinkedInSearch[] {
  return countries.map(([id, location, label, datePosted]) => ({
    id: `any-backend-${id}`,
    group,
    label: `${label} · Backend/Full stack · ${age(datePosted)}`,
    keywords: ANY_BACKEND,
    location,
    datePosted,
    sortByDate: true,
  }));
}

const egypt: Partial<LinkedInSearch> = { group: 'egypt', location: 'Egypt', geoId: LINKEDIN_GEO.egypt, sortByDate: true };
const remote: Partial<LinkedInSearch> = { group: 'remote', location: 'Worldwide', geoId: LINKEDIN_GEO.worldwide, workplace: ['remote'], sortByDate: true };

export const linkedinSearches: LinkedInSearch[] = [
  // ⚡ Past hour, newest first: open these several times a day to be among the first applicants.
  { ...egypt, id: 'fresh-egypt-node-backend', group: 'fresh', label: '⚡ Egypt · Node/Backend · 1 h', keywords: `(${NODE} OR ${BACKEND}) ${EXCLUDE}`, datePosted: 'past-hour' },
  { ...remote, id: 'fresh-remote-node', group: 'fresh', label: '⚡ Remote · Node.js · 1 h', keywords: `${NODE} ${EXCLUDE}`, datePosted: 'past-hour' },

  // 🇪🇬 Egypt: on-site, hybrid and remote roles based in Egypt.
  { ...egypt, id: 'backend-egypt-24h', label: 'Egypt · Backend · 24 h', keywords: `${BACKEND} ${EXCLUDE}`, datePosted: 'past-24h' },
  { ...egypt, id: 'nestjs-egypt-24h', label: 'Egypt · Node.js / NestJS · 24 h', keywords: `${NODE} ${EXCLUDE}`, datePosted: 'past-24h' },
  { ...egypt, id: 'fullstack-node-egypt-24h', label: 'Egypt · Full stack Node · 24 h', keywords: `${FULL_STACK} AND ${NODE}`, datePosted: 'past-24h' },
  { ...egypt, id: 'software-engineer-egypt-24h', label: 'Egypt · Software Engineer · 24 h', keywords: `${GENERIC} AND (Node OR NestJS OR TypeScript OR Backend) ${EXCLUDE}`, datePosted: 'past-24h' },
  { ...egypt, id: 'arabic-backend-egypt-week', label: 'مصر · مطور باك اند · أسبوع', keywords: '"مطور باك اند" OR "مبرمج Node" OR "مطور Node.js" OR "مطور خلفية"', datePosted: 'past-week' },
  { ...egypt, id: 'remote-from-egypt-week', label: 'Egypt · Remote Node/Backend · week', keywords: `(${NODE} OR ${BACKEND}) ${EXCLUDE}`, datePosted: 'past-week', workplace: ['remote'] },
  { ...egypt, id: 'senior-backend-egypt-week', label: 'Egypt · Senior Backend · week', keywords: `(Senior OR Sr) AND (${NODE} OR ${BACKEND}) ${EXCLUDE}`, datePosted: 'past-week', experience: ['mid-senior'] },
  { ...egypt, id: 'junior-mid-backend-egypt-week', label: 'Egypt · Junior/Mid Backend · week', keywords: `(${NODE} OR ${BACKEND}) ${EXCLUDE}`, datePosted: 'past-week', experience: ['entry', 'associate'] },
  { ...egypt, id: 'typescript-backend-egypt-week', label: 'Egypt · TypeScript backend · week', keywords: `TypeScript AND (${BACKEND} OR ${NODE}) ${EXCLUDE}`, datePosted: 'past-week' },
  { ...egypt, id: 'onsite-hybrid-egypt-24h', label: 'Egypt · On-site/Hybrid · 24 h', keywords: ANY_BACKEND, datePosted: 'past-24h', workplace: ['on-site', 'hybrid'] },
  { ...egypt, id: 'programmer-sde-egypt-week', label: 'Egypt · Programmer/SDE/MERN · week', keywords: `(Programmer OR SDE OR "Software Development Engineer" OR MERN OR "MEAN Stack" OR "Web Developer") AND (Node OR NodeJS OR "Node.js" OR NestJS OR Express) ${EXCLUDE}`, datePosted: 'past-week' },
  { ...egypt, id: 'easy-apply-egypt-24h', label: 'Egypt · Easy Apply · 24 h', keywords: `(${NODE} OR ${BACKEND}) ${EXCLUDE}`, datePosted: 'past-24h', easyApplyOnly: true },

  // 🏙 Gulf: one search per country, plus the two big markets' Node-only and fresh views.
  { group: 'fresh', id: 'fresh-gulf-node', label: '⚡ Saudi · Node/Backend · 1 h', keywords: ANY_BACKEND, location: 'Saudi Arabia', datePosted: 'past-hour', sortByDate: true },
  { group: 'fresh', id: 'fresh-uae-node', label: '⚡ UAE · Node/Backend · 1 h', keywords: ANY_BACKEND, location: 'United Arab Emirates', datePosted: 'past-hour', sortByDate: true },
  ...countrySearches('gulf', GULF),
  { group: 'gulf', id: 'onsite-hybrid-saudi-week', label: 'Saudi · On-site/Hybrid Node · week', keywords: `${NODE} ${EXCLUDE}`, location: 'Saudi Arabia', datePosted: 'past-week', workplace: ['on-site', 'hybrid'], sortByDate: true },
  { group: 'gulf', id: 'onsite-hybrid-uae-week', label: 'UAE · On-site/Hybrid Node · week', keywords: `${NODE} ${EXCLUDE}`, location: 'United Arab Emirates', datePosted: 'past-week', workplace: ['on-site', 'hybrid'], sortByDate: true },
  { group: 'gulf', id: 'remote-gulf-week', label: 'Gulf · Remote Node · week', keywords: `${NODE} AND (GCC OR Gulf OR KSA OR UAE OR "Saudi Arabia" OR Dubai OR Riyadh) ${EXCLUDE}`, location: 'Worldwide', geoId: LINKEDIN_GEO.worldwide, workplace: ['remote'], datePosted: 'past-week', sortByDate: true },

  // 🌙 MENA (outside Egypt and the Gulf).
  ...countrySearches('mena', MENA),

  // 🌍 Remote worldwide: the profile's eligibility check still rejects country-restricted roles.
  { ...remote, id: 'node-remote-24h', label: 'Remote · Node.js · 24 h', keywords: `${NODE} ${EXCLUDE}`, datePosted: 'past-24h' },
  { ...remote, id: 'node-remote-week', label: 'Remote · Node.js · week', keywords: `${NODE} ${EXCLUDE}`, datePosted: 'past-week' },
  { ...remote, id: 'nestjs-remote-week', label: 'Remote · NestJS · week', keywords: 'NestJS', datePosted: 'past-week' },
  { ...remote, id: 'backend-typescript-remote-24h', label: 'Remote · Backend TypeScript · 24 h', keywords: `${BACKEND} AND (TypeScript OR Node) ${EXCLUDE}`, datePosted: 'past-24h' },
  { ...remote, id: 'fullstack-node-remote-24h', label: 'Remote · Full stack Node · 24 h', keywords: `${FULL_STACK} AND ${NODE}`, datePosted: 'past-24h' },
  { ...remote, id: 'senior-backend-remote-week', label: 'Remote · Senior Backend · week', keywords: `(Senior OR Sr) AND (${NODE} OR ${BACKEND}) ${EXCLUDE}`, datePosted: 'past-week', experience: ['mid-senior'] },
  { ...remote, id: 'emea-node-remote-week', label: 'Remote · EMEA/MENA Node · week', keywords: `${NODE} AND (EMEA OR MENA OR "Middle East" OR Africa OR Egypt) ${EXCLUDE}`, datePosted: 'past-week' },
  { ...remote, id: 'contract-node-remote-week', label: 'Remote · Node contract · week', keywords: `(${NODE} OR ${BACKEND}) ${EXCLUDE}`, datePosted: 'past-week', employmentTypes: ['contract'] },
];
