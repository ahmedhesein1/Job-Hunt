import { normalizeForMatch } from './skills';

export type Workplace = 'remote' | 'hybrid' | 'on-site';

/**
 * Workplace type stated in a job's own text, or undefined when the text does not say.
 *
 * Title and location are checked first (short, explicit: "Backend Engineer - Remote",
 * "Cairo (Hybrid)"). The description only counts with explicit phrases: a remote role
 * needs "fully remote", "work from home"…, and any hybrid or office-attendance wording
 * makes it hybrid or on-site, because "remote" alone appears in many office jobs
 * ("remote-friendly team", "occasional remote work").
 */
const SHORT_REMOTE = /\b(remote|remotely|wfh|work from home|work from anywhere)\b|عن بعد/;
const SHORT_HYBRID = /\bhybrid\b|هجين/;
const SHORT_ONSITE = /\b(on[- ]?site|in[- ]office|office[- ]based)\b/;

const DESC_REMOTE = [
  /\b(fully|100%|100 %|completely|entirely|full[- ]time) remote\b/,
  /\bremote[- ](first|only|position|role|job|opportunity|based|contract)\b/,
  /\bthis (is a|is an|position is|role is|job is) (fully )?remote\b/,
  /\b(work|working) (fully )?remotely\b/,
  /\b(work|working) from (home|anywhere)\b/,
  /\bremote work(ing)? (from|is)\b/,
  /\bremote\s*\((worldwide|global|anywhere|emea|mena|europe|africa)\)/,
  /عن بعد بالكامل|العمل عن بعد/,
];
const DESC_HYBRID = [/\bhybrid\b/, /\b\d\s*(days?|x)\s*(a|per|\/)\s*week\b.{0,40}\b(office|on[- ]?site)\b/, /\bsplit between (home|remote) and (the )?office\b/];
const DESC_ONSITE = [
  /\b(on[- ]?site|onsite) (role|position|job|work|only)\b/,
  /\bwork(ing)? from (our|the) office\b/,
  /\b(in[- ]office|office[- ]based)\b/,
  /\b(relocation|relocate)\b/,
  /\bmust (be able to )?(commute|work on[- ]?site)\b/,
];

function fromShort(text: string): Workplace | undefined {
  if (SHORT_HYBRID.test(text)) return 'hybrid';
  if (SHORT_ONSITE.test(text)) return 'on-site';
  if (SHORT_REMOTE.test(text)) return 'remote';
  return undefined;
}

function fromDescription(text: string): Workplace | undefined {
  if (DESC_HYBRID.some((p) => p.test(text))) return 'hybrid';
  if (DESC_ONSITE.some((p) => p.test(text))) return 'on-site';
  if (DESC_REMOTE.some((p) => p.test(text))) return 'remote';
  return undefined;
}

export function workplaceFromText(input: { title?: string | undefined; location?: string | undefined; description?: string | undefined }): Workplace | undefined {
  const short = fromShort(normalizeForMatch(`${input.title ?? ''}\n${input.location ?? ''}`));
  if (short) return short;
  return input.description ? fromDescription(normalizeForMatch(input.description)) : undefined;
}
