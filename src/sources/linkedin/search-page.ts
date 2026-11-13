import { parse, type HTMLElement } from 'node-html-parser';

/**
 * Parser for LinkedIn job-search result pages saved by the owner from their own browser.
 * It takes HTML and nothing else, so it works with any page source.
 *
 * LinkedIn's markup is undocumented and changes, so cards are located in three ways, in
 * order: the logged-out layout (`.jobs-search__results-list > li`), the signed-in layout
 * (`[data-occludable-job-id]` / `[data-job-id]` cards), and finally any element holding a
 * `/jobs/view/<id>` link. Fields are read from several candidate selectors per layout and
 * every value is optional except the job ID, title and company.
 */
export type SnapshotLayout = 'logged-out' | 'signed-in' | 'generic';

export interface LinkedInCard {
  jobId: string;
  /** Canonical public posting URL: https://www.linkedin.com/jobs/view/<id>/ */
  url: string;
  title: string;
  company: string;
  location?: string | undefined;
  /** From "(Remote)" / "(Hybrid)" / "(On-site)" in the location line, when present. */
  workplace?: 'remote' | 'hybrid' | 'on-site' | undefined;
  /** Posting age as displayed, e.g. "2 hours ago" / "منذ ساعتين". */
  postedText?: string | undefined;
  /** ISO time derived from the card; see `postedAtPrecise`. */
  postedAt?: string | undefined;
  /**
   * True when the age is known well enough for freshness rules: a full timestamp or a
   * relative age (a lower bound). False for a bare date.
   */
  postedAtPrecise: boolean;
  logoUrl?: string | undefined;
}

export type SnapshotResult =
  | {
      status: 'ok';
      layout: SnapshotLayout;
      cards: LinkedInCard[];
      /** Card elements found, including duplicates and unrendered placeholders. */
      cardsSeen: number;
      /** Signed-in list items LinkedIn had not rendered yet (scroll before saving). */
      placeholders: number;
      /** Cards with a job ID but no usable title or company. */
      malformed: number;
    }
  /** The page is a sign-in wall or a security check, not results. */
  | { status: 'blocked'; reason: 'authwall' | 'challenge' }
  /** Not a LinkedIn job-search page, or no job cards in it. */
  | { status: 'empty'; reason: string };

export interface ParseOptions {
  /** When the page was captured; relative ages ("3 hours ago") are counted from here. */
  capturedAtMs: number;
  maxCards?: number;
}

const DEFAULT_MAX_CARDS = 300;
const LINKEDIN_HOST = /^(?:[a-z]{2,3}\.|www\.)?linkedin\.com$/i;
/** Company logos; static.licdn.com serves only LinkedIn's grey placeholder images. */
const LOGO_HOST = /^media\.licdn\.com$/i;

const SELECTORS = {
  title: ['.base-search-card__title', 'a.base-card__full-link span.sr-only', '.job-card-list__title--link strong', '.job-card-list__title', '.artdeco-entity-lockup__title', '.job-card-container__link strong'],
  company: ['.base-search-card__subtitle', '.job-card-container__primary-description', '.artdeco-entity-lockup__subtitle', 'a[href*="/company/"]'],
  location: ['.job-search-card__location', '.job-card-container__metadata-item', '.artdeco-entity-lockup__caption li', '.artdeco-entity-lockup__caption'],
} as const;

// ------------------------------------------------------------------ text helpers

/** Bidi/zero-width marks that LinkedIn inserts around mixed Arabic/English text. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function cleanText(value: string | undefined): string {
  return (value ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

function textOf(el: HTMLElement | null | undefined): string {
  return el ? cleanText(el.text) : '';
}

function firstText(root: HTMLElement, selectors: readonly string[]): string {
  for (const selector of selectors) {
    for (const el of root.querySelectorAll(selector)) {
      const text = textOf(el);
      if (text) return text;
    }
  }
  return '';
}

/** "Backend Engineer with verification" → "Backend Engineer" (signed-in badge text). */
function cleanTitle(title: string): string {
  return title.replace(/\s+with verification$/i, '').trim();
}

// ------------------------------------------------------------------ URLs and IDs

const VIEW_PATH = /\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/;

/** Job ID from a LinkedIn job link, or undefined when the link is not a LinkedIn posting. */
export function jobIdFromUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  let url: URL;
  try {
    url = new URL(href, 'https://www.linkedin.com');
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !LINKEDIN_HOST.test(url.hostname)) return undefined;
  const fromPath = VIEW_PATH.exec(url.pathname)?.[1];
  if (fromPath) return fromPath;
  const current = url.searchParams.get('currentJobId');
  return current && /^\d{6,}$/.test(current) ? current : undefined;
}

export function canonicalJobUrl(jobId: string): string {
  return `https://www.linkedin.com/jobs/view/${jobId}/`;
}

function idFromAttributes(el: HTMLElement): string | undefined {
  const urn = el.getAttribute('data-entity-urn') ?? '';
  const fromUrn = /urn:li:jobPosting:(\d{6,})/.exec(urn)?.[1];
  if (fromUrn) return fromUrn;
  for (const attr of ['data-job-id', 'data-occludable-job-id']) {
    const value = el.getAttribute(attr);
    if (value && /^\d{6,}$/.test(value)) return value;
  }
  return undefined;
}

function cardJobId(card: HTMLElement): string | undefined {
  const own = idFromAttributes(card);
  if (own) return own;
  for (const el of card.querySelectorAll('[data-entity-urn], [data-job-id], [data-occludable-job-id]')) {
    const id = idFromAttributes(el);
    if (id) return id;
  }
  for (const a of card.querySelectorAll('a[href]')) {
    const id = jobIdFromUrl(a.getAttribute('href'));
    if (id) return id;
  }
  return undefined;
}

function logoUrl(card: HTMLElement): string | undefined {
  for (const img of card.querySelectorAll('img')) {
    for (const attr of ['data-delayed-url', 'src']) {
      const value = img.getAttribute(attr);
      if (!value) continue;
      try {
        const url = new URL(value);
        if (url.protocol === 'https:' && LOGO_HOST.test(url.hostname)) return url.toString();
      } catch {
        // relative or data: URLs are not logos we can show
      }
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ location / workplace

const WORKPLACE_PATTERNS: Array<[RegExp, NonNullable<LinkedInCard['workplace']>]> = [
  [/\((?:remote|عن بُ?عد)\)|^(?:remote|عن بُ?عد)$/i, 'remote'],
  [/\((?:hybrid|هجين|مختلط)\)|^(?:hybrid|هجين|مختلط)$/i, 'hybrid'],
  [/\((?:on-site|onsite|في الموقع|بالموقع)\)|^(?:on-site|onsite|في الموقع)$/i, 'on-site'],
];

export function splitLocation(raw: string): { location?: string; workplace?: LinkedInCard['workplace'] } {
  const text = cleanText(raw);
  if (!text) return {};
  const workplace = WORKPLACE_PATTERNS.find(([re]) => re.test(text))?.[1];
  const location = cleanText(text.replace(/\((?:remote|hybrid|on-site|onsite|عن بُ?عد|هجين|مختلط|في الموقع|بالموقع)\)/gi, ''));
  return { location: location || undefined, workplace };
}

// ------------------------------------------------------------------ posting age

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNIT_MS = { minute: MINUTE, hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY } as const;
type Unit = keyof typeof UNIT_MS;

function westernDigits(value: string): string {
  return value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

const ARABIC_UNITS: Array<{ unit: Unit; single: RegExp; dual: RegExp; plural: RegExp }> = [
  { unit: 'minute', single: /دقيقة/, dual: /دقيقتين|دقيقتان/, plural: /دقائق|دقيقة/ },
  { unit: 'hour', single: /ساعة/, dual: /ساعتين|ساعتان/, plural: /ساعات|ساعة/ },
  { unit: 'day', single: /يوم/, dual: /يومين|يومان/, plural: /أيام|ايام|يوم/ },
  { unit: 'week', single: /أسبوع|اسبوع/, dual: /أسبوعين|اسبوعين|أسبوعان/, plural: /أسابيع|اسابيع|أسبوع|اسبوع/ },
  { unit: 'month', single: /شهر/, dual: /شهرين|شهران/, plural: /أشهر|اشهر|شهور|شهر/ },
];

/** Milliseconds since posting for "3 hours ago" / "منذ 3 ساعات" etc., or undefined. */
export function parseRelativeAge(raw: string): { ms: number; unit: Unit } | undefined {
  const text = westernDigits(cleanText(raw)).toLowerCase();
  if (!text) return undefined;
  if (/just now|moments? ago|الآن|للتو/.test(text)) return { ms: 0, unit: 'minute' };
  const en = /(\d+|an?|one)\s+(minute|min|hour|hr|day|week|month)s?\b/.exec(text);
  if (en) {
    const n = /^\d+$/.test(en[1] ?? '') ? Number(en[1]) : 1;
    const unitWord = en[2] as string;
    const unit: Unit = unitWord.startsWith('min') ? 'minute' : unitWord.startsWith('h') ? 'hour' : (unitWord as Unit);
    return { ms: n * UNIT_MS[unit], unit };
  }
  if (!/منذ|قبل/.test(text)) return undefined;
  for (const { unit, single, dual, plural } of ARABIC_UNITS) {
    const number = /(\d+)/.exec(text)?.[1];
    if (number && plural.test(text)) return { ms: Number(number) * UNIT_MS[unit], unit };
    if (dual.test(text)) return { ms: 2 * UNIT_MS[unit], unit };
    if (single.test(text)) return { ms: UNIT_MS[unit], unit };
  }
  return undefined;
}

function postedInfo(card: HTMLElement, capturedAtMs: number): Pick<LinkedInCard, 'postedText' | 'postedAt' | 'postedAtPrecise'> {
  const time = card.querySelector('time');
  const postedText = textOf(time) || undefined;
  const datetime = time?.getAttribute('datetime')?.trim();
  if (datetime && /^\d{4}-\d{2}-\d{2}T/.test(datetime) && Number.isFinite(Date.parse(datetime))) {
    return { postedText, postedAt: new Date(Date.parse(datetime)).toISOString(), postedAtPrecise: true };
  }
  // "3 days ago" / "1 week ago" are rounded down, so the age is a lower bound: safe for
  // the "older than 72 h is not alerted" rule.
  const relative = postedText ? parseRelativeAge(postedText) : undefined;
  if (relative) return { postedText, postedAt: new Date(capturedAtMs - relative.ms).toISOString(), postedAtPrecise: true };
  if (datetime && /^\d{4}-\d{2}-\d{2}$/.test(datetime)) {
    // Date only, in the viewer's time zone: midday UTC is within a day of the truth.
    return { postedText, postedAt: `${datetime}T12:00:00.000Z`, postedAtPrecise: false };
  }
  return { postedText, postedAtPrecise: false };
}

// ------------------------------------------------------------------ page-level detection

function detectBlock(root: HTMLElement): 'authwall' | 'challenge' | undefined {
  const title = textOf(root.querySelector('title')).toLowerCase();
  const html = root.toString();
  if (/security verification|captcha|checkpoint\/challenge|let'?s do a quick security check/i.test(`${title} ${html.slice(0, 200_000)}`)) return 'challenge';
  if (/sign ?up|sign ?in|log ?in|join linkedin|authwall/.test(title) || root.querySelector('.authwall, form.authwall-join-form, #session_key')) return 'authwall';
  return undefined;
}

/** Outermost matches only: drops elements nested inside another match. */
function outermost(elements: HTMLElement[]): HTMLElement[] {
  const set = new Set(elements);
  return elements.filter((el) => {
    for (let p = el.parentNode; p; p = p.parentNode) if (set.has(p)) return false;
    return true;
  });
}

function locateCards(root: HTMLElement): { layout: SnapshotLayout; cards: HTMLElement[] } | undefined {
  const loggedOut = root.querySelectorAll('.jobs-search__results-list > li');
  if (loggedOut.length > 0) return { layout: 'logged-out', cards: loggedOut };

  const signedIn = root.querySelectorAll('li[data-occludable-job-id]');
  if (signedIn.length > 0) return { layout: 'signed-in', cards: signedIn };
  const jobIdCards = outermost(root.querySelectorAll('[data-job-id], [data-entity-urn*="urn:li:jobPosting:"]'));
  if (jobIdCards.length > 0) return { layout: 'signed-in', cards: jobIdCards };

  // Unknown layout: the nearest list item (or parent) of each job link.
  const fromLinks = root
    .querySelectorAll('a[href*="/jobs/view/"]')
    .filter((a) => jobIdFromUrl(a.getAttribute('href')))
    .map((a) => a.closest('li') ?? a.parentNode ?? a);
  if (fromLinks.length > 0) return { layout: 'generic', cards: outermost([...new Set(fromLinks)]) };
  return undefined;
}

function readCard(card: HTMLElement, capturedAtMs: number): { card?: LinkedInCard; placeholder?: boolean; malformed?: boolean; jobId?: string } {
  const jobId = cardJobId(card);
  if (!jobId) return { malformed: true };

  const link = card.querySelectorAll('a[href]').find((a) => jobIdFromUrl(a.getAttribute('href')) === jobId);
  let title = cleanTitle(firstText(card, SELECTORS.title));
  if (!title && link) title = cleanTitle(cleanText(link.getAttribute('aria-label')) || textOf(link));
  const company = firstText(card, SELECTORS.company);
  // Signed-in lists keep off-screen items as empty shells holding only the job ID.
  if (!title && !company && textOf(card).length === 0) return { placeholder: true, jobId };
  if (!title || !company || title.length > 300) return { malformed: true, jobId };

  const { location, workplace } = splitLocation(firstText(card, SELECTORS.location));
  return {
    jobId,
    card: {
      jobId,
      url: canonicalJobUrl(jobId),
      title,
      company: company.slice(0, 200),
      location: location?.slice(0, 200),
      workplace,
      ...postedInfo(card, capturedAtMs),
      logoUrl: logoUrl(card),
    },
  };
}

export function parseLinkedInSearchPage(html: string, options: ParseOptions): SnapshotResult {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    // Listed with `false`: content dropped instead of parsed (scripts, styles).
    blockTextElements: { script: false, style: false, noscript: false, template: false, pre: true },
  });
  const located = locateCards(root);
  if (!located) {
    const blocked = detectBlock(root);
    if (blocked) return { status: 'blocked', reason: blocked };
    return { status: 'empty', reason: 'no LinkedIn job cards found in the page' };
  }

  const maxCards = options.maxCards ?? DEFAULT_MAX_CARDS;
  const byId = new Map<string, LinkedInCard>();
  let placeholders = 0;
  let malformed = 0;
  const seen = located.cards.slice(0, maxCards);
  for (const element of seen) {
    const result = readCard(element, options.capturedAtMs);
    if (result.placeholder) placeholders += 1;
    else if (result.malformed) malformed += 1;
    else if (result.card && !byId.has(result.card.jobId)) byId.set(result.card.jobId, result.card);
  }
  return { status: 'ok', layout: located.layout, cards: [...byId.values()], cardsSeen: seen.length, placeholders, malformed };
}
