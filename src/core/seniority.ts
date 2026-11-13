import type { Seniority } from '../../config/profiles';
import { containsTerm, normalizeForMatch } from './skills';

export interface SeniorityResult {
  level: Seniority | undefined;
  /** Title evidence that the role is clearly senior (§6.2). */
  clearlySenior: boolean;
  /** Leadership / people-management title (lead, staff, principal, head, manager…). */
  leadership: boolean;
  evidence?: string;
}

/** "Senior" alone is a level a profile may accept; these titles are leadership roles. */
const SENIOR_TERMS = ['senior', 'sr'];
const LEADERSHIP_TERMS = ['lead', 'staff', 'principal', 'head', 'architect', 'director', 'vp', 'chief'];
const INTERN_TERMS = ['intern', 'internship', 'trainee'];
const JUNIOR_TERMS = ['junior', 'jr', 'entry level', 'graduate', 'associate'];
const MID_TERMS = ['mid', 'mid level', 'intermediate', 'ii'];

/**
 * "manager" alone is not rejected (§6.2): only people-management titles such as
 * "Engineering Manager" or "Manager, Software Development" count as clearly senior.
 */
const PEOPLE_MANAGER = /(?:engineering|development|software|dev|technical|tech|team)\s+manager|manager\s*,?\s*(?:of\s+)?(?:software|engineering|development|backend)/u;

function mapHint(hint: string): Seniority | undefined {
  const h = normalizeForMatch(hint);
  if (/intern/.test(h)) return 'intern';
  if (/entry|junior|graduate/.test(h)) return 'junior';
  if (/mid|intermediate/.test(h)) return 'mid';
  if (/senior|lead|staff|principal|director|manager|executive|head/.test(h)) return 'senior';
  return undefined;
}

export function classifySeniority(title: string, hints: readonly string[] = []): SeniorityResult {
  const t = normalizeForMatch(title);
  const leadTerm = LEADERSHIP_TERMS.find((term) => containsTerm(t, term));
  if (leadTerm) return { level: 'senior', clearlySenior: true, leadership: true, evidence: leadTerm };
  if (PEOPLE_MANAGER.test(t)) return { level: 'senior', clearlySenior: true, leadership: true, evidence: 'people manager' };
  const seniorTerm = SENIOR_TERMS.find((term) => containsTerm(t, term));
  if (seniorTerm) return { level: 'senior', clearlySenior: true, leadership: false, evidence: seniorTerm };
  if (INTERN_TERMS.some((term) => containsTerm(t, term))) return { level: 'intern', clearlySenior: false, leadership: false };
  if (JUNIOR_TERMS.some((term) => containsTerm(t, term))) return { level: 'junior', clearlySenior: false, leadership: false };
  if (MID_TERMS.some((term) => containsTerm(t, term))) return { level: 'mid', clearlySenior: false, leadership: false };

  // Source-provided levels (Himalayas seniority[], Jobicy jobLevel). Several values
  // (e.g. ["Mid-level","Senior"]) mean the role is open to the lowest of them.
  const mapped = hints.map(mapHint).filter((v): v is Seniority => v !== undefined);
  if (mapped.length > 0) {
    const order: Seniority[] = ['intern', 'junior', 'mid', 'senior'];
    const lowest = mapped.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    return { level: lowest, clearlySenior: false, leadership: false };
  }
  return { level: undefined, clearlySenior: false, leadership: false };
}

const EXPERIENCE_WORD = /(experience|exp\b|professional|industry|commercial|working|خبرة)/u;
const YEAR_PATTERNS: RegExp[] = [
  // "3-5 years", "3 to 5 years" → minimum is the first number
  /(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s*\+?\s*(?:years?|yrs?)/giu,
  // "5+ years", "5 years", "at least 5 years", "minimum of 5 years", "5 or more years"
  /(?:at\s+least|minimum(?:\s+of)?|min\.?|over)?\s*(\d{1,2})\s*\+?\s*(?:or\s+more\s+)?(?:years?|yrs?)/giu,
  // Arabic: "خبرة 3 سنوات" / "3 سنوات خبرة"
  /(\d{1,2})\s*(?:سنوات|سنة|سنين)/gu,
];

/**
 * Minimum years of experience required by the description, or undefined when the
 * description does not state it (§6.2: missing is UNKNOWN, not a rejection).
 * Only numbers with an experience word within ~60 characters are considered.
 */
export function extractMinYears(text: string | undefined): number | undefined {
  if (!text) return undefined;
  let required: number | undefined;
  // Each pattern runs on a copy where earlier matches are blanked out, so the upper
  // bound of "3-5 years" is not re-read as "5 years" by the next pattern.
  let working = text;
  for (const pattern of YEAR_PATTERNS) {
    pattern.lastIndex = 0;
    const consumed: Array<[number, number]> = [];
    for (const match of working.matchAll(pattern)) {
      const start = match.index ?? 0;
      const years = Number(match[1]);
      if (!Number.isFinite(years) || years < 1 || years > 15) continue;
      const window = text.slice(Math.max(0, start - 60), start + match[0].length + 60).toLowerCase();
      if (!EXPERIENCE_WORD.test(window)) continue;
      consumed.push([start, start + match[0].length]);
      // The overall requirement is the strictest stated minimum.
      required = required === undefined ? years : Math.max(required, years);
    }
    for (const [s, e] of consumed) working = working.slice(0, s) + ' '.repeat(e - s) + working.slice(e);
  }
  return required;
}
