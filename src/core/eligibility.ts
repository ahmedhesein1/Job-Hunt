import type { RemoteRegion, SearchProfile } from '../../config/profiles';
import { cairoUtcOffsetHours } from '../lib/time';
import { containsTerm, normalizeForMatch } from './skills';

export type EligibilityStatus = 'ELIGIBLE' | 'EXCLUDED' | 'UNKNOWN';

export interface EligibilityInput {
  /** Job title: Gulf postings often state "Saudi nationals only" there. */
  title?: string | undefined;
  location?: string | undefined;
  locationRestrictions?: string[] | undefined;
  countryCode?: string | undefined;
  remote?: boolean | undefined;
  /** Plain-text description (already stripped of HTML). */
  description?: string | undefined;
  tags?: string[] | undefined;
  /** Numeric UTC offsets the employer accepts (Himalayas timezoneRestrictions). */
  timezoneOffsets?: number[] | undefined;
}

export interface EligibilityResult {
  status: EligibilityStatus;
  /** Human label, e.g. "Remote (EMEA)", "Cairo, Egypt", "Remote". */
  remoteScope: string;
  eligibleRegions: string[];
  reason?: string;
}

/** Country terms per ISO code for profile.locations.countries. */
const COUNTRY_TERMS: Record<string, string[]> = {
  EG: [
    'egypt', 'cairo', 'giza', 'alexandria', 'new cairo', 'smart village', 'maadi', 'nasr city', 'heliopolis',
    'sheikh zayed', '6th of october', 'october city', 'new capital', 'mansoura', 'tanta', 'zagazig', 'assiut',
    'ismailia', 'port said', 'suez', 'hurghada', 'luxor', 'aswan',
    'مصر', 'القاهرة', 'الجيزة', 'الإسكندرية', 'الاسكندرية',
  ],
  // Gulf (GCC)
  SA: [
    'saudi arabia', 'saudi', 'ksa', 'kingdom of saudi arabia', 'riyadh', 'jeddah', 'jiddah', 'dammam', 'khobar',
    'al khobar', 'dhahran', 'makkah', 'mecca', 'madinah', 'medina', 'tabuk', 'abha', 'neom',
    'السعودية', 'المملكة العربية السعودية', 'الرياض', 'جدة', 'الدمام', 'الخبر', 'مكة', 'المدينة المنورة',
  ],
  AE: [
    'uae', 'u.a.e', 'united arab emirates', 'emirates', 'dubai', 'abu dhabi', 'sharjah', 'ajman', 'ras al khaimah',
    'fujairah', 'al ain', 'difc', 'adgm',
    'الإمارات', 'الامارات', 'دبي', 'أبوظبي', 'ابوظبي', 'أبو ظبي', 'الشارقة',
  ],
  QA: ['qatar', 'doha', 'lusail', 'قطر', 'الدوحة'],
  KW: ['kuwait', 'kuwait city', 'الكويت'],
  BH: ['bahrain', 'manama', 'البحرين', 'المنامة'],
  OM: ['oman', 'muscat', 'sultanate of oman', 'سلطنة عمان', 'مسقط'],
  // Wider MENA
  JO: ['jordan', 'amman', 'الأردن', 'الاردن', 'عمان'],
  LB: ['lebanon', 'beirut', 'لبنان', 'بيروت'],
  IQ: ['iraq', 'baghdad', 'erbil', 'basra', 'العراق', 'بغداد', 'أربيل'],
  MA: ['morocco', 'casablanca', 'rabat', 'marrakech', 'tangier', 'المغرب', 'الدار البيضاء', 'الرباط'],
  TN: ['tunisia', 'tunis', 'sfax', 'تونس'],
  DZ: ['algeria', 'algiers', 'oran', 'الجزائر'],
  LY: ['libya', 'benghazi', 'ليبيا', 'بنغازي'],
};

const REGION_TERMS: Record<RemoteRegion, string[]> = {
  WORLDWIDE: ['worldwide', 'anywhere', 'global', 'globally', 'international', 'any location', 'all countries'],
  EMEA: ['emea'],
  AFRICA: ['africa', 'north africa'],
  MENA: [
    'mena', 'middle east', 'middle east and north africa', 'mea', 'middle east and africa', 'middle east & africa',
    'gcc', 'gulf', 'gulf region', 'gcc region', 'arab world', 'الشرق الأوسط', 'الخليج', 'دول الخليج',
  ],
};

/**
 * Roles reserved for citizens of one country (Saudization, Emiratisation…). Applied even
 * when the location is in an accepted country: the owner is not a national there.
 */
const NATIONALITY = '(?:saudi|emirati|uae|qatari|kuwaiti|omani|bahraini|jordanian|lebanese|gcc)';
const NATIONALS_ONLY: RegExp[] = [
  new RegExp(`(?i:${NATIONALITY}\\s+(?:nationals?|citizens?)(?:\\s+(?:candidates|applicants))?\\s*(?:only|are\\s+required|is\\s+required|required))`, 'u'),
  new RegExp(`(?i:(?:only|exclusively)\\s+(?:for|open\\s+to|available\\s+to)\\s+${NATIONALITY}\\s+(?:nationals?|citizens?))`, 'u'),
  new RegExp(`(?i:(?:saudi|emirati|qatari|kuwaiti|omani|bahraini)(?:s|z)ation\\s+(?:role|position|job|vacancy|program(?:me)?))`, 'u'),
  /(?:للسعوديين|للمواطنين|للإماراتيين|للقطريين|للكويتيين|للعمانيين|للبحرينيين)\s*فقط/u,
  /(?:سعودي|إماراتي|اماراتي|قطري|كويتي|عماني|بحريني)\s+الجنسية/u,
];

/** Regions/countries that clearly do not include Egypt. Matched whole-word. */
const NON_EGYPT_PLACES = [
  'us', 'usa', 'u.s', 'u.s.', 'united states', 'america', 'americas', 'north america', 'latam', 'latin america',
  'south america', 'canada', 'mexico', 'brazil', 'argentina', 'colombia', 'chile', 'peru',
  'uk', 'united kingdom', 'england', 'ireland', 'europe', 'eu', 'european union', 'eea', 'cet', 'germany',
  'france', 'spain', 'portugal', 'italy', 'netherlands', 'belgium', 'poland', 'romania', 'sweden', 'norway',
  'denmark', 'finland', 'switzerland', 'austria', 'czech republic', 'czechia', 'hungary', 'greece', 'ukraine',
  'apac', 'asia', 'asia pacific', 'india', 'pakistan', 'bangladesh', 'sri lanka', 'philippines', 'indonesia',
  'vietnam', 'thailand', 'malaysia', 'singapore', 'japan', 'china', 'korea', 'south korea', 'taiwan',
  'hong kong', 'australia', 'new zealand', 'oceania', 'israel', 'turkey', 'south africa', 'nigeria', 'kenya',
  // Remaining countries outside the profile (found by a live dry run: "Sofia, Bulgaria"
  // was UNKNOWN instead of EXCLUDED). Profile countries must never appear here.
  'bulgaria', 'serbia', 'croatia', 'slovenia', 'slovakia', 'bosnia', 'bosnia and herzegovina', 'montenegro',
  'albania', 'north macedonia', 'kosovo', 'moldova', 'belarus', 'russia', 'lithuania', 'latvia', 'estonia',
  'iceland', 'luxembourg', 'malta', 'cyprus', 'georgia', 'armenia', 'azerbaijan', 'kazakhstan', 'uzbekistan',
  'ghana', 'ethiopia', 'uganda', 'rwanda', 'tanzania', 'senegal', 'cameroon', 'ivory coast', "cote d'ivoire",
  'zambia', 'zimbabwe', 'botswana', 'namibia', 'mozambique', 'angola', 'mauritius', 'iran', 'afghanistan',
  'nepal', 'cambodia', 'myanmar', 'mongolia', 'uruguay', 'paraguay', 'bolivia', 'ecuador', 'venezuela',
  'costa rica', 'panama', 'guatemala', 'honduras', 'el salvador', 'nicaragua', 'dominican republic',
  'puerto rico', 'jamaica', 'cuba',
  // Major tech cities, for locations given without a country.
  'london', 'manchester', 'berlin', 'munich', 'hamburg', 'paris', 'amsterdam', 'rotterdam', 'madrid',
  'barcelona', 'lisbon', 'porto', 'warsaw', 'krakow', 'bucharest', 'cluj', 'sofia', 'belgrade', 'zagreb',
  'prague', 'budapest', 'vienna', 'zurich', 'geneva', 'stockholm', 'copenhagen', 'oslo', 'helsinki', 'dublin',
  'tallinn', 'kyiv', 'kiev', 'istanbul', 'ankara', 'tel aviv', 'nairobi', 'lagos', 'cape town', 'johannesburg',
  'toronto', 'vancouver', 'montreal', 'new york', 'san francisco', 'seattle', 'austin', 'boston', 'chicago',
  'bangalore', 'bengaluru', 'hyderabad', 'pune', 'mumbai', 'delhi', 'gurgaon', 'noida', 'chennai', 'karachi',
  'lahore', 'islamabad', 'dhaka', 'manila', 'jakarta', 'kuala lumpur', 'tokyo', 'seoul', 'shanghai',
  'beijing', 'shenzhen', 'sydney', 'melbourne', 'sao paulo', 'mexico city', 'bogota', 'buenos aires', 'lima',
];

const NON_EGYPT_US_STATE = /,\s*(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;

/**
 * Explicit "X only" style exclusions in free text (§6.2). Abbreviations are matched
 * case-sensitively so ordinary words ("contact us only by email") never trigger an
 * exclusion; phrases and full place names use inline case-insensitive groups.
 */
const PLACE_ABBR = '(?:US|USA|U\\.S\\.(?:A\\.)?|UK|EU|EEA|APAC|LATAM)';
const PLACE_NAMES =
  '(?i:united states|united kingdom|europe|european union|canada|north america|latin america|the americas|asia|india|australia|germany)';
const PLACE = `(?:(?i:the\\s+)?(?:${PLACE_ABBR}|${PLACE_NAMES}))`;
const END = '(?![\\p{L}\\p{N}])';
const EXCLUSION_PATTERNS: RegExp[] = [
  new RegExp(`(?<![\\p{L}\\p{N}])${PLACE}[\\s-]*(?i:only)${END}`, 'u'),
  new RegExp(`(?i:must\\s+(?:be\\s+)?(?:currently\\s+)?(?:located|based|residing|reside|living|live)\\s+in)\\s+${PLACE}${END}`, 'u'),
  new RegExp(
    `(?i:(?:only|exclusively)\\s+(?:open\\s+to|accepting|hiring|considering)(?:\\s+(?:candidates|applicants|people))?(?:\\s+who\\s+are)?(?:\\s+(?:located|based|residing))?\\s+in)\\s+${PLACE}${END}`,
    'u',
  ),
  new RegExp(`(?i:(?:legally\\s+)?authori[sz]ed\\s+to\\s+work\\s+in)\\s+${PLACE}${END}`, 'u'),
  // "Remote - US" / "Remote (UK)" is a location label, not a restriction on who can apply:
  // remote roles in any country are accepted (owner decision 2026-11-13).
];

const REMOTE_WORDS = ['remote', 'remotely', 'work from home', 'wfh', 'distributed', 'عن بعد'];

function regionLabel(region: RemoteRegion): string {
  return region === 'WORLDWIDE' ? 'Worldwide' : region === 'AFRICA' ? 'Africa' : region;
}

interface Classified {
  inProfileCountry: string | undefined;
  inProfileRegion: RemoteRegion | undefined;
  nonEgyptPlace: string | undefined;
}

/** ISO codes of every known country whose name or cities appear in `text`. */
export function countriesIn(text: string): string[] {
  const n = normalizeForMatch(text);
  return Object.entries(COUNTRY_TERMS)
    .filter(([, terms]) => terms.some((t) => containsTerm(n, t)))
    .map(([code]) => code);
}

function classify(text: string, profile: SearchProfile): Classified {
  const n = normalizeForMatch(text);
  let inProfileCountry: string | undefined;
  for (const code of profile.locations.countries) {
    if ((COUNTRY_TERMS[code] ?? []).some((t) => containsTerm(n, t))) inProfileCountry = code;
  }
  const inProfileRegion = profile.locations.remoteRegions.find((r) => REGION_TERMS[r].some((t) => containsTerm(n, t)));
  const nonEgyptPlace = NON_EGYPT_PLACES.find((p) => containsTerm(n, p)) ?? (NON_EGYPT_US_STATE.test(text) ? 'US state' : undefined);
  return { inProfileCountry, inProfileRegion, nonEgyptPlace };
}

function tzOverlapHours(offsetA: number, offsetB: number): number {
  // Overlap of two 09:00–17:00 local working days.
  return Math.max(0, 8 - Math.abs(offsetA - offsetB));
}

export function evaluateEligibility(input: EligibilityInput, profile: SearchProfile, nowMs: number): EligibilityResult {
  const location = (input.location ?? '').trim();
  const restrictions = (input.locationRestrictions ?? []).map((r) => r.trim()).filter(Boolean);
  const locClass = classify(location, profile);
  const isRemote =
    input.remote ?? (REMOTE_WORDS.some((w) => containsTerm(normalizeForMatch(location), w)) ? true : undefined);

  // 0. Citizens-only roles exclude regardless of location.
  const nationalsText = [input.title ?? '', location, input.description ?? ''].join('\n');
  const nationals = NATIONALS_ONLY.map((p) => p.exec(nationalsText)).find(Boolean);
  if (nationals) {
    return { status: 'EXCLUDED', remoteScope: location || 'Restricted', eligibleRegions: [], reason: `nationals only: "${nationals[0].trim()}"` };
  }

  // 1. Explicit "US only" / "must be based in the EU" text is the clearest evidence.
  //    Only a *specific* mention of the profile's country or region (e.g. "Remote — US
  //    or EMEA") overrides it; a generic "Worldwide" label does not.
  const specific = (c: Classified) => Boolean(c.inProfileCountry || (c.inProfileRegion && c.inProfileRegion !== 'WORLDWIDE'));
  const freeText = [location, input.description ?? ''].join('\n');
  for (const pattern of EXCLUSION_PATTERNS) {
    const match = pattern.exec(freeText);
    if (match && !specific(locClass)) {
      const restrictionsAllow = restrictions.some((r) => specific(classify(r, profile)));
      if (!restrictionsAllow) {
        return { status: 'EXCLUDED', remoteScope: location || 'Restricted', eligibleRegions: [], reason: `location: "${match[0].trim()}"` };
      }
    }
  }

  // 2. Structured restriction lists (Himalayas country names, Jobicy geo, etc.).
  if (restrictions.length > 0) {
    const classified = restrictions.map((r) => ({ r, c: classify(r, profile) }));
    const country = classified.find((x) => x.c.inProfileCountry);
    if (country) return { status: 'ELIGIBLE', remoteScope: `Remote (${country.r})`, eligibleRegions: [country.r] };
    const region = classified.find((x) => x.c.inProfileRegion);
    if (region) {
      const label = regionLabel(region.c.inProfileRegion as RemoteRegion);
      return { status: 'ELIGIBLE', remoteScope: `Remote (${label})`, eligibleRegions: [label] };
    }
    return {
      status: 'EXCLUDED',
      remoteScope: `Remote (${restrictions.slice(0, 3).join(', ')})`,
      eligibleRegions: [],
      reason: `restricted to ${restrictions.slice(0, 3).join(', ')}`,
    };
  }

  // 3. Timezone restrictions: require the profile's minimum working-hour overlap.
  const offsets = (input.timezoneOffsets ?? []).filter((o) => Number.isFinite(o));
  if (offsets.length > 0) {
    const cairo = cairoUtcOffsetHours(nowMs);
    const best = Math.max(...offsets.map((o) => tzOverlapHours(o, cairo)));
    if (best < profile.locations.minTzOverlapHours) {
      return { status: 'EXCLUDED', remoteScope: 'Remote (timezone-restricted)', eligibleRegions: [], reason: `timezone overlap ${best} h` };
    }
  }

  // 4. Free-text location.
  if (locClass.inProfileCountry) {
    return {
      status: 'ELIGIBLE',
      remoteScope: isRemote ? `Remote (${location})` : location,
      eligibleRegions: [locClass.inProfileCountry],
    };
  }
  if (input.countryCode && profile.locations.countries.includes(input.countryCode.toUpperCase())) {
    return { status: 'ELIGIBLE', remoteScope: location || input.countryCode, eligibleRegions: [input.countryCode.toUpperCase()] };
  }
  if (locClass.inProfileRegion) {
    const label = regionLabel(locClass.inProfileRegion);
    return { status: 'ELIGIBLE', remoteScope: `Remote (${label})`, eligibleRegions: [label] };
  }

  if (isRemote === true) {
    // Remote roles in any country are accepted (owner decision 2026-11-13); explicit
    // restrictions on who can apply were rejected above. Whether the employer hires from
    // Egypt is unknown, not rejected (§6.2).
    // The scope keeps the stated country ("Remote (Germany)"); otherwise plain "Remote" as before
    // (the scope is part of the dedupe fingerprint).
    const named = locClass.nonEgyptPlace || countriesIn(location).length > 0;
    const scope = !named ? 'Remote' : REMOTE_WORDS.some((w) => containsTerm(normalizeForMatch(location), w)) ? location : `Remote (${location})`;
    return { status: 'UNKNOWN', remoteScope: scope, eligibleRegions: [] };
  }

  // On-site / hybrid outside Egypt.
  if (input.countryCode && !profile.locations.countries.includes(input.countryCode.toUpperCase())) {
    return { status: 'EXCLUDED', remoteScope: location || input.countryCode, eligibleRegions: [], reason: `on-site in ${input.countryCode}` };
  }
  // A known country outside the profile (e.g. "Riyadh, Saudi Arabia", "Dubai (Hybrid)") with
  // no remote wording: on-site or hybrid there.
  const outside = countriesIn(location).filter((code) => !profile.locations.countries.includes(code));
  if (outside.length > 0) {
    return { status: 'EXCLUDED', remoteScope: location, eligibleRegions: [], reason: `on-site in ${location}` };
  }
  // A location naming only places outside the profile, with no remote wording, is an
  // on-site role there (remote roles returned above). Most ATS feeds leave `remote`
  // unset rather than false.
  if (locClass.nonEgyptPlace) {
    return { status: 'EXCLUDED', remoteScope: location, eligibleRegions: [], reason: `on-site in ${location}` };
  }
  return { status: 'UNKNOWN', remoteScope: location || 'Unknown location', eligibleRegions: [] };
}
