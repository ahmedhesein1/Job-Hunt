/**
 * Source policy registry (§5.1). Each entry records the allowed access method, the
 * minimum interval we enforce in code, attribution rules, permitted hosts and the
 * terms page that was reviewed. EventBridge schedules in template.yaml set the
 * *cadence*; `minIntervalMinutes` is a hard floor enforced at run time so a
 * misconfigured schedule can never poll faster than the source allows.
 *
 * Verification notes (2026-11-10): see test/fixtures and §19 of the plan.
 */
export type SourceId =
  | 'himalayas'
  | 'remoteok'
  | 'wuzzuf'
  | 'jobicy'
  | 'hn'
  | 'linkedin-email'
  | 'linkedin-snapshot'
  | 'linkedin-search'
  | 'company-boards'
  | 'career-pages'
  | 'career-pages-js';

export type AccessMethod = 'json-api' | 'rss' | 'ats-api' | 'email' | 'algolia-api' | 'html-jsonld' | 'manual-snapshot' | 'authorized-provider';

/**
 * Company career pages scraped as HTML (§0.3, §5.7): only sites whose robots.txt allows
 * the pages (checked automatically on every run) and whose terms permit automated access
 * (checked by a person before adding the entry — record the date in `termsReviewed`).
 * Jobs are read from schema.org JobPosting JSON-LD on each job page.
 */
export interface CareerPage {
  /** Short stable ID, e.g. "acme". */
  id: string;
  company: string;
  /** Page that lists the open jobs (HTTPS). */
  listUrl: string;
  /**
   * Regex (source string) matched against absolute job-page URLs found on the list page.
   * Defaults to DEFAULT_JOB_LINK_PATTERN.
   */
  jobLinkPattern?: string;
  /**
   * The listing only appears after JavaScript runs: fetched by the headless-browser
   * function (source `career-pages-js`, §5.7) instead of plain HTTP.
   */
  render?: boolean;
  /**
   * The page lists many employers' jobs (a job board): the company comes from each job's
   * own data, and `company` is only the attribution label ("via …").
   */
  aggregator?: boolean;
  /** Date a person checked the site's terms permit automated access (YYYY-MM-DD). */
  termsReviewed: string;
}

/** Same-host links whose path looks like an individual job page. */
export const DEFAULT_JOB_LINK_PATTERN =
  '/(?:jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|opportunit(?:y|ies)|roles?)/[^?#]*[a-z0-9][^?#/]*/?(?:[?#].*)?$';

const WUZZUF_JOB_LINK = '^https://wuzzuf\\.net/jobs/p/[a-z0-9]+-[a-z0-9-]+$';

/** Wuzzuf category listing pages (same terms review as the entries below). */
function wuzzufCategories(entries: Array<[id: string, slug: string]>): CareerPage[] {
  return entries.map(([id, slug]) => ({
    id,
    company: 'Wuzzuf',
    listUrl: `https://wuzzuf.net/a/${slug}`,
    jobLinkPattern: WUZZUF_JOB_LINK,
    aggregator: true,
    termsReviewed: '2026-11-11',
  }));
}

export const careerPages: CareerPage[] = [
  // Reviewed 2026-11-11: robots.txt allows; job pages publish JobPosting JSON-LD (employer
  // job ads meant for aggregators); no terms of use cover the careers site. Listing page 1
  // only (~10 newest jobs). Excluded: Yassir (terms forbid extraction/reuse).
  {
    id: 'talabat',
    company: 'talabat',
    listUrl: 'https://careers.deliveryhero.com/talabat',
    jobLinkPattern: '^https://careers\\.deliveryhero\\.com/job/[a-z0-9-]+-jid-\\d+$',
    termsReviewed: '2026-11-11',
  },
  // Reviewed 2026-11-11: robots.txt disallows only /wp-admin/; terms cover the app only.
  {
    id: 'rabbitmart',
    company: 'Rabbit Mart',
    listUrl: 'https://www.rabbitmart.com/careers/',
    jobLinkPattern: '^https://www\\.rabbitmart\\.com/careers/[0-9a-f]{8}-[a-z0-9-]+/?$',
    termsReviewed: '2026-11-11',
  },
  // Reviewed 2026-11-11: careers.sarwa.co (Teamtailor, custom domain) allows /jobs and
  // /jobs/{id}; only privacy/cookie policies on the careers site.
  {
    id: 'sarwa',
    company: 'Sarwa',
    listUrl: 'https://careers.sarwa.co/jobs',
    jobLinkPattern: '^https://careers\\.sarwa\\.co/jobs/\\d+-[a-z0-9-]+$',
    termsReviewed: '2026-11-11',
  },
  // Wuzzuf category pages (server-rendered, no query string). Reviewed 2026-11-11:
  // robots.txt "User-agent: * / Allow: /" (only named AI crawlers are blocked); User
  // Agreement allows personal, non-commercial use, no redistribution. The official RSS
  // feed stopped updating on 2026-11-03, so these pages replace it. Job pages carry
  // JobPosting JSON-LD. At most 10 new job pages per page per run.
  {
    id: 'wuzzuf-node',
    company: 'Wuzzuf',
    listUrl: 'https://wuzzuf.net/a/Node-Js-Jobs-in-Egypt',
    jobLinkPattern: '^https://wuzzuf\\.net/jobs/p/[a-z0-9]+-[a-z0-9-]+$',
    aggregator: true,
    termsReviewed: '2026-11-11',
  },
  {
    id: 'wuzzuf-backend',
    company: 'Wuzzuf',
    listUrl: 'https://wuzzuf.net/a/Backend-Jobs-in-Egypt',
    jobLinkPattern: '^https://wuzzuf\\.net/jobs/p/[a-z0-9]+-[a-z0-9-]+$',
    aggregator: true,
    termsReviewed: '2026-11-11',
  },
  // More backend-related Wuzzuf categories (owner decision 2026-11-11), each confirmed to
  // exist with job links on 2026-11-11. Overlapping jobs are fetched once (seen-page
  // tracking). The /saudi/ section redirects automated clients and is not used.
  ...wuzzufCategories([
    ['wuzzuf-backend-developer', 'Backend-Developer-Jobs-in-Egypt'],
    ['wuzzuf-full-stack', 'Full-Stack-Jobs-in-Egypt'],
    ['wuzzuf-nestjs', 'Nestjs-Jobs-in-Egypt'],
    ['wuzzuf-typescript', 'Typescript-Jobs-in-Egypt'],
    ['wuzzuf-software-engineer', 'Software-Engineer-Jobs-in-Egypt'],
    ['wuzzuf-software-developer', 'Software-Developer-Jobs-in-Egypt'],
    ['wuzzuf-software-development', 'Software-Development-Jobs-in-Egypt'],
    ['wuzzuf-programmer', 'Programmer-Jobs-in-Egypt'],
    ['wuzzuf-backend-uae', 'Backend-Jobs-in-United-Arab-Emirates'],
  ]),
  // Reviewed 2026-11-11: robots.txt disallows only wp-admin/login paths; no website terms.
  // The job list is rendered by React (no job links in the HTML): needs the browser.
  { id: 'automattic', company: 'Automattic', listUrl: 'https://automattic.com/work-with-us/jobs/', render: true, termsReviewed: '2026-11-11' },
  // JavaScript-only listings, loaded by the headless browser (§5.7).
  // Reviewed 2026-11-11: no robots.txt rules (SPA), no terms page found.
  { id: 'brightskies', company: 'Brightskies', listUrl: 'https://brightskiesinc.com/careers', render: true, termsReviewed: '2026-11-11' },
  // Breadfast removed 2026-11-11: its careers backend (Freshteam) returns "Invalid account URL".
];

/** Bounded work per run (§4.2 spirit): new job pages fetched per site and in total. */
export const careerPagesLimits = { maxNewPagesPerSite: 10, maxNewPagesPerRun: 40, timeBudgetMs: 80_000 } as const;

export interface SourcePolicy {
  id: SourceId;
  name: string;
  method: AccessMethod;
  /** Disabled sources never run, regardless of schedule. */
  enabled: boolean;
  /** Why the source is disabled, shown in /status. */
  disabledReason?: string;
  minIntervalMinutes: number;
  /** Exact hostnames or `*.suffix` patterns that requests/redirects may target. */
  allowedHosts: string[];
  /** Check robots.txt before fetching (website-hosted feeds). */
  respectRobots: boolean;
  attribution: string;
  /** Fields we are allowed to persist. */
  storedFields: string;
  /** Canonical URL rule for the job link we show. */
  canonicalUrl: string;
  termsUrl: string;
  /** Whether jobs from this source may seed company-board discovery (§4.1). */
  allowsBoardDiscovery: boolean;
  /**
   * Expected max silence before /status reports the source as stale. Undefined for
   * sources that only run when the owner sends something (never stale).
   */
  staleAfterMinutes: number | undefined;
  phase: 1 | 2 | 3;
}

const HOUR = 60;

export const sources: Record<SourceId, SourcePolicy> = {
  himalayas: {
    id: 'himalayas',
    name: 'Himalayas',
    method: 'json-api',
    enabled: true,
    // Docs: data refreshes every 24 h; "no benefit" to polling more often.
    minIntervalMinutes: 20 * HOUR,
    allowedHosts: ['himalayas.app'],
    respectRobots: false,
    attribution: 'Visible "via Himalayas" credit linking to himalayas.app; Apply must use applicationLink.',
    storedFields: 'title, company, location restrictions, seniority, salary, categories, dates, applicationLink, guid',
    canonicalUrl: 'guid (himalayas.app job URL); Apply = applicationLink',
    termsUrl: 'https://himalayas.app/docs/remote-jobs-api',
    // Apply links are himalayas.app URLs and re-syndication is prohibited.
    allowsBoardDiscovery: false,
    staleAfterMinutes: 30 * HOUR,
    phase: 1,
  },
  remoteok: {
    id: 'remoteok',
    name: 'Remote OK',
    method: 'json-api',
    enabled: true,
    // No published limit; 2 h is our own conservative starting cadence (§4).
    minIntervalMinutes: 2 * HOUR - 10,
    allowedHosts: ['remoteok.com'],
    respectRobots: false,
    attribution: 'Mention Remote OK as the source and link (follow) to the Remote OK listing URL.',
    storedFields: 'position, company, tags, location, salary, dates, url',
    canonicalUrl: 'url (remoteok.com listing)',
    termsUrl: 'https://remoteok.com/api',
    allowsBoardDiscovery: false,
    staleAfterMinutes: 6 * HOUR,
    phase: 1,
  },
  wuzzuf: {
    id: 'wuzzuf',
    name: 'Wuzzuf',
    method: 'rss',
    // Reviewed 2026-11-11: the official RSS feed is linked in the site footer; robots.txt
    // allows /feeds/; the User Agreement permits viewing/downloading materials for
    // personal, non-commercial use and forbids redistribution. This is a single-user
    // personal tool and nothing is republished, so the feed is used as offered.
    // The feed is ~15 MB with Cache-Control max-age=14400 (4 h): never poll faster.
    enabled: true,
    // Schedule: rate(4 hours) with a 5-minute flexible window.
    minIntervalMinutes: 4 * HOUR - 10,
    allowedHosts: ['wuzzuf.net'],
    respectRobots: true,
    attribution: 'Link to the original Wuzzuf listing.',
    storedFields: 'title, company, location, link, pubDate',
    canonicalUrl: 'item link',
    termsUrl: 'https://wuzzuf.net/policies',
    allowsBoardDiscovery: false,
    staleAfterMinutes: 12 * HOUR,
    phase: 1,
  },
  jobicy: {
    id: 'jobicy',
    name: 'Jobicy',
    method: 'json-api',
    enabled: true,
    // API guidance: do not start new automated sync passes more often than hourly.
    // Schedule: fixed rate(65 minutes), no flexible window, so this floor never skips a run.
    minIntervalMinutes: HOUR,
    allowedHosts: ['jobicy.com'],
    respectRobots: false,
    attribution: 'Credit Jobicy with a direct link; keep the canonical Jobicy URL for Apply.',
    storedFields: 'jobTitle, companyName, jobGeo, jobLevel, salary, pubDate, url',
    canonicalUrl: 'url (jobicy.com)',
    termsUrl: 'https://github.com/Jobicy/remote-jobs-api',
    allowsBoardDiscovery: false,
    staleAfterMinutes: 4 * HOUR,
    phase: 2,
  },
  hn: {
    id: 'hn',
    name: 'Hacker News',
    method: 'algolia-api',
    enabled: true,
    // Schedule: rate(1 hour) with a 5-minute flexible window; the adapter itself drops to
    // daily once the thread is older than 72 h.
    minIntervalMinutes: HOUR - 10,
    allowedHosts: ['hn.algolia.com'],
    respectRobots: false,
    attribution: 'Link to the original HN comment.',
    storedFields: 'comment text summary, author-provided company/role/location, links',
    canonicalUrl: 'https://news.ycombinator.com/item?id=<commentId>',
    termsUrl: 'https://hn.algolia.com/api',
    allowsBoardDiscovery: true,
    staleAfterMinutes: 30 * HOUR,
    phase: 3,
  },
  'linkedin-email': {
    id: 'linkedin-email',
    name: 'LinkedIn alerts',
    method: 'email',
    // Requires Gmail OAuth credentials and parser fixtures from the user's own alert
    // emails (§12). Enabled by the GmailEnabled deploy parameter (env GMAIL_ENABLED).
    enabled: process.env.GMAIL_ENABLED === 'true',
    disabledReason: 'Needs Gmail OAuth credentials in SSM and saved alert-email fixtures (plan §12, §17 Phase 3).',
    minIntervalMinutes: 9,
    allowedHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'],
    respectRobots: false,
    attribution: 'Link to the public LinkedIn job URL.',
    storedFields: 'title, company, location, public job URL',
    canonicalUrl: 'https://www.linkedin.com/jobs/view/<id>/',
    termsUrl: 'https://www.linkedin.com/help/linkedin/answer/a1340567',
    allowsBoardDiscovery: false,
    staleAfterMinutes: 2 * HOUR,
    phase: 3,
  },
  'linkedin-snapshot': {
    id: 'linkedin-snapshot',
    name: 'LinkedIn saved pages',
    method: 'manual-snapshot',
    // Runs only when the owner sends a search-results page saved from their own browser
    // to the bot.
    enabled: true,
    minIntervalMinutes: 0,
    allowedHosts: [],
    respectRobots: false,
    attribution: 'Link to the public LinkedIn job URL.',
    storedFields: 'title, company, location, posting age, public job URL',
    canonicalUrl: 'https://www.linkedin.com/jobs/view/<id>/',
    termsUrl: 'https://www.linkedin.com/legal/user-agreement',
    allowsBoardDiscovery: false,
    staleAfterMinutes: undefined,
    phase: 3,
  },
  'linkedin-search': {
    id: 'linkedin-search',
    name: 'LinkedIn searches (39 × every 3 min)',
    method: 'authorized-provider',
    // Owner requirement 2026-11-11: all saved searches are matched every 3 minutes against
    // jobs received through enabled LinkedIn alert email and saved-page imports.
    enabled: true,
    minIntervalMinutes: 0,
    allowedHosts: [],
    respectRobots: true,
    attribution: 'Link to the public LinkedIn job URL.',
    storedFields: 'title, company, location, public job URL',
    canonicalUrl: 'https://www.linkedin.com/jobs/view/<id>/',
    termsUrl: 'https://www.linkedin.com/legal/user-agreement',
    allowsBoardDiscovery: false,
    staleAfterMinutes: 15,
    phase: 3,
  },
  'career-pages': {
    id: 'career-pages',
    name: 'Career pages',
    method: 'html-jsonld',
    enabled: true,
    // Schedule: rate(2 hours) with a 5-minute flexible window.
    minIntervalMinutes: 2 * HOUR - 10,
    // Exactly the hosts of the configured pages; redirects elsewhere are rejected.
    get allowedHosts() {
      return [...new Set(careerPages.filter((p) => !p.render).map((p) => new URL(p.listUrl).hostname))];
    },
    respectRobots: true,
    attribution: 'Link to the employer job page.',
    storedFields: 'JobPosting title, company, location, dates, salary, URL',
    canonicalUrl: 'JobPosting url (employer page)',
    termsUrl: 'per site — see careerPages[].termsReviewed',
    allowsBoardDiscovery: true,
    staleAfterMinutes: 6 * HOUR,
    phase: 2,
  },
  'career-pages-js': {
    id: 'career-pages-js',
    name: 'Career pages (rendered)',
    method: 'html-jsonld',
    enabled: true,
    // Schedule: rate(3 hours). Headless Chromium is the most expensive fetch we make.
    minIntervalMinutes: 3 * HOUR - 10,
    get allowedHosts() {
      return [...new Set(careerPages.filter((p) => p.render).map((p) => new URL(p.listUrl).hostname))];
    },
    respectRobots: true,
    attribution: 'Link to the employer job page.',
    storedFields: 'JobPosting (or page heading/text) title, company, location, URL',
    canonicalUrl: 'employer job page',
    termsUrl: 'per site — see careerPages[].termsReviewed',
    allowsBoardDiscovery: true,
    staleAfterMinutes: 8 * HOUR,
    phase: 2,
  },
  'company-boards': {
    id: 'company-boards',
    name: 'Company boards',
    method: 'ats-api',
    enabled: true,
    minIntervalMinutes: 4,
    allowedHosts: [
      'boards-api.greenhouse.io',
      'api.lever.co',
      'api.eu.lever.co',
      'api.ashbyhq.com',
      // Workable's documented endpoint redirects to apply.workable.com.
      'www.workable.com',
      'apply.workable.com',
      '*.recruitee.com',
      '*.teamtailor.com',
      '*.jobs.personio.de',
      '*.jobs.personio.com',
      '*.bamboohr.com',
    ],
    respectRobots: false,
    attribution: 'Link to the employer posting.',
    storedFields: 'published posting fields only',
    canonicalUrl: 'ATS posting URL',
    termsUrl: 'https://docs.greenhouse.io/job-board',
    allowsBoardDiscovery: true,
    staleAfterMinutes: 60,
    phase: 2,
  },
};

export const syncableSourceIds = ['himalayas', 'remoteok', 'wuzzuf', 'jobicy', 'hn', 'career-pages', 'career-pages-js'] as const;
export type SyncableSourceId = (typeof syncableSourceIds)[number];

export function isSyncableSourceId(value: unknown): value is SyncableSourceId {
  return typeof value === 'string' && (syncableSourceIds as readonly string[]).includes(value);
}

/** Himalayas search queries (§4: follow pagination only when required). */
// Owner decision 2026-11-11: every backend-related family. Max 3 pages each, once per 20 h.
export const himalayasQueries = ['node', 'nodejs', 'nestjs', 'backend', 'full stack', 'typescript', 'software engineer'] as const;
export const himalayasMaxPagesPerQuery = 3;

/** Jobicy filters kept constant across pages (cursor rule). */
export const jobicyQuery = { count: 100, industry: 'engineering' } as const;
export const jobicyMaxPages = 3;

/** Expected LinkedIn alert senders (§12). */
export const linkedinAlertSenders = ['jobalerts-noreply@linkedin.com', 'jobs-listings@linkedin.com'];

/**
 * Supported careers-page systems (public, keyless job feeds; verified 2026-11-11).
 * Not supported by policy: SmartRecruiters (robots.txt disallows all bots on its API
 * host) and Breezy (terms forbid access outside supported interfaces).
 * Recruitee requires a per-company token from 2027-02-10; its boards will then return
 * 401 and pause for review.
 */
export type AtsProvider = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'recruitee' | 'teamtailor' | 'personio' | 'bamboohr';

export interface WatchlistBoard {
  ats: AtsProvider;
  token: string;
  company: string;
  priority: 'high' | 'normal';
}

/**
 * Curated employer watchlist (§4.2). Add boards here or via /missed <ats-url>.
 * High priority boards move to 30-minute checks only after source-policy review and
 * stable responses (the maintenance task promotes them; see data/boards.ts).
 */
export const watchlistBoards: WatchlistBoard[] = [
  // Each board verified with a 200 response on 2026-11-11.
  // Egypt-based → high priority (moves to 30-minute checks after 24 stable checks).
  { ats: 'ashby', token: 'thndr', company: 'Thndr', priority: 'high' },
  { ats: 'lever', token: 'Bosta', company: 'Bosta', priority: 'high' },
  { ats: 'lever', token: 'klivvr', company: 'Klivvr', priority: 'high' },
  { ats: 'recruitee', token: 'synapseanalytics', company: 'Synapse Analytics', priority: 'high' },
  { ats: 'workable', token: 'robusta', company: 'Robusta', priority: 'high' },
  { ats: 'workable', token: 'nawy-real-estate', company: 'Nawy', priority: 'high' },
  { ats: 'workable', token: 'dopay-8', company: 'Dopay', priority: 'high' },
  // No open jobs on 2026-11-11 — kept to catch new postings (404s retire automatically).
  { ats: 'workable', token: 'moneyfellows', company: 'MoneyFellows', priority: 'high' },
  { ats: 'workable', token: 'swvl', company: 'Swvl', priority: 'high' },
  { ats: 'workable', token: 'vezeeta', company: 'Vezeeta', priority: 'high' },
  { ats: 'workable', token: 'tagaddod', company: 'Tagaddod', priority: 'high' },
  { ats: 'recruitee', token: 'elmenus', company: 'Elmenus', priority: 'high' },
  // MENA / remote-first employers.
  { ats: 'ashby', token: 'LeanTech', company: 'Lean Technologies', priority: 'normal' },
  { ats: 'ashby', token: 'andela', company: 'Andela', priority: 'normal' },
  { ats: 'ashby', token: 'supabase', company: 'Supabase', priority: 'normal' },
  { ats: 'ashby', token: 'n8n', company: 'n8n', priority: 'normal' },
  { ats: 'ashby', token: 'posthog', company: 'PostHog', priority: 'normal' },
  { ats: 'greenhouse', token: 'canonical', company: 'Canonical', priority: 'normal' },
  { ats: 'greenhouse', token: 'tamara', company: 'Tamara', priority: 'normal' },
  { ats: 'greenhouse', token: 'careem', company: 'Careem', priority: 'normal' },
  { ats: 'greenhouse', token: 'gitlab', company: 'GitLab', priority: 'normal' },
  { ats: 'greenhouse', token: 'grafanalabs', company: 'Grafana Labs', priority: 'normal' },
  { ats: 'greenhouse', token: 'wikimedia', company: 'Wikimedia Foundation', priority: 'normal' },
  { ats: 'workable', token: 'foodics', company: 'Foodics', priority: 'normal' },
  { ats: 'teamtailor', token: 'propertyfinder', company: 'Property Finder', priority: 'normal' },
  // Verified 2026-11-11. Turing's own site is bot-walled; its Greenhouse board is public.
  { ats: 'greenhouse', token: 'turing', company: 'Turing', priority: 'normal' },
  // Luciq (formerly Instabug), Cairo: BambooHR careers list; robots.txt allows all.
  { ats: 'bamboohr', token: 'instabug', company: 'Luciq (Instabug)', priority: 'high' },
  // Gulf / MENA employers (owner decision 2026-11-11). Each verified 2026-11-11 against the
  // provider's public job-board API: board name matched and open jobs returned.
  { ats: 'workable', token: 'cequens', company: 'CEQUENS', priority: 'high' },
  { ats: 'workable', token: 'salla', company: 'Salla', priority: 'normal' },
  { ats: 'workable', token: 'lucidya', company: 'Lucidya', priority: 'normal' },
  { ats: 'recruitee', token: 'unifonic', company: 'Unifonic', priority: 'normal' },
  { ats: 'ashby', token: 'ziina', company: 'Ziina', priority: 'normal' },
  { ats: 'bamboohr', token: 'nymcard', company: 'NymCard', priority: 'normal' },
];
