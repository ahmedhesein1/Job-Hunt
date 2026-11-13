import type { SearchProfile } from '../../config/profiles';
import type { NormalizedJob } from './normalize';
import { containsTerm, matchingTerms, normalizeForMatch } from './skills';

/** §6.3 weights. */
export const WEIGHTS = { title: 30, skills: 30, eligibility: 20, experience: 20 } as const;
const TOTAL_WEIGHT = WEIGHTS.title + WEIGHTS.skills + WEIGHTS.eligibility + WEIGHTS.experience;

const NODE_ECOSYSTEM_TITLE_TERMS = ['node', 'nodejs', 'node.js', 'nestjs'];

export type Evaluation =
  | { decision: 'REJECT'; profileId: string; reasons: string[] }
  | {
      decision: 'MATCH';
      profileId: string;
      score: number;
      confidence: number;
      breakdown: Record<keyof typeof WEIGHTS, number | 'UNKNOWN'>;
    };

export interface EvaluationContext {
  mutedCompanies: ReadonlySet<string>;
}

/** §6.2 hard filters — reject only on clear evidence. */
export function hardFilterReasons(job: NormalizedJob, profile: SearchProfile, ctx: EvaluationContext): string[] {
  const reasons: string[] = [];
  const title = normalizeForMatch(job.title);
  const excluded = matchingTerms(title, profile.titleExclude);
  if (excluded.length > 0) reasons.push(`title excludes: ${excluded.join(', ')}`);
  if (matchingTerms(title, profile.titleInclude).length === 0) reasons.push('title not backend/node');
  if (job.leadership) reasons.push('leadership role');
  else if (job.clearlySenior && !profile.seniority.accept.includes('senior')) reasons.push('senior role');
  if (job.minYears !== undefined && job.minYears > profile.seniority.maxYears) reasons.push(`requires ${job.minYears}+ years`);
  if (job.eligibility === 'EXCLUDED') reasons.push(`not Egypt-eligible (${job.eligibilityReason ?? 'location'})`);
  if (ctx.mutedCompanies.has(job.companyKey)) reasons.push('company muted');
  if (job.hasDescription) {
    const missing = profile.mustHaveSkills.filter((s) => !job.skills.includes(s));
    if (missing.length > 0) reasons.push(`missing must-have: ${missing.join(', ')}`);
  }
  if (profile.minSalaryUsdMonth !== undefined && job.salary?.usdMonthlyMax !== undefined && job.salary.usdMonthlyMax < profile.minSalaryUsdMonth) {
    reasons.push('salary below minimum');
  }
  return reasons;
}

function titlePoints(job: NormalizedJob): number {
  const title = normalizeForMatch(job.title);
  // A Node-ecosystem title is the strongest signal; a generic backend title still fits.
  return NODE_ECOSYSTEM_TITLE_TERMS.some((t) => containsTerm(title, t)) ? WEIGHTS.title : Math.round(WEIGHTS.title * 0.8);
}

function skillPoints(job: NormalizedJob, profile: SearchProfile): number | 'UNKNOWN' {
  if (!job.hasDescription && job.tags.length === 0) return 'UNKNOWN';
  const must = profile.mustHaveSkills.length;
  const mustShare = must === 0 ? 1 : profile.mustHaveSkills.filter((s) => job.skills.includes(s)).length / must;
  // Matching about half the nice-to-have list counts as a full skills fit.
  const niceTarget = Math.max(1, Math.ceil(profile.niceSkills.length / 2));
  const niceShare = Math.min(1, profile.niceSkills.filter((s) => job.skills.includes(s)).length / niceTarget);
  return Math.round(WEIGHTS.skills * (0.5 * mustShare + 0.5 * niceShare));
}

function eligibilityPoints(job: NormalizedJob): number | 'UNKNOWN' {
  return job.eligibility === 'ELIGIBLE' ? WEIGHTS.eligibility : 'UNKNOWN';
}

function experiencePoints(job: NormalizedJob, profile: SearchProfile): number | 'UNKNOWN' {
  if (job.minYears !== undefined) {
    if (job.minYears <= profile.seniority.maxYears - 2) return WEIGHTS.experience;
    return Math.round(WEIGHTS.experience * 0.7);
  }
  if (job.seniority === undefined) return 'UNKNOWN';
  if (profile.seniority.accept.includes(job.seniority)) return WEIGHTS.experience;
  if (job.seniority === 'intern') return Math.round(WEIGHTS.experience * 0.25);
  return 0;
}

/**
 * §6.3: score = earned / possible among KNOWN dimensions × 100;
 * confidence = known weight / total weight.
 */
export function evaluate(job: NormalizedJob, profile: SearchProfile, ctx: EvaluationContext): Evaluation {
  const reasons = hardFilterReasons(job, profile, ctx);
  if (reasons.length > 0) return { decision: 'REJECT', profileId: profile.id, reasons };

  const breakdown = {
    title: titlePoints(job),
    skills: skillPoints(job, profile),
    eligibility: eligibilityPoints(job),
    experience: experiencePoints(job, profile),
  } as const;
  let earned = 0;
  let possible = 0;
  for (const key of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) {
    const points = breakdown[key];
    if (points === 'UNKNOWN') continue;
    earned += points;
    possible += WEIGHTS[key];
  }
  const score = possible === 0 ? 0 : Math.round((earned / possible) * 100);
  const confidence = Math.round((possible / TOTAL_WEIGHT) * 100) / 100;
  return { decision: 'MATCH', profileId: profile.id, score, confidence, breakdown };
}

const DIMENSION_LABELS: Record<keyof typeof WEIGHTS, string> = { title: 'title', skills: 'skills', eligibility: 'location', experience: 'experience' };

/**
 * Short human explanation of a decision: the hard-filter reasons for a rejection, or the
 * points earned per dimension for a match ("?" = not stated by the source).
 */
export function explainEvaluation(evaluation: Evaluation): string {
  if (evaluation.decision === 'REJECT') return evaluation.reasons.join('; ');
  return (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>)
    .map((key) => {
      const points = evaluation.breakdown[key];
      return points === 'UNKNOWN' ? `${DIMENSION_LABELS[key]} ?` : `${DIMENSION_LABELS[key]} ${points}/${WEIGHTS[key]}`;
    })
    .join(' · ');
}

/** Best match across all profiles; REJECT only if every profile rejects. */
export function evaluateAll(job: NormalizedJob, profiles: readonly SearchProfile[], ctx: EvaluationContext): Evaluation & { matchedProfiles: string[] } {
  const results = profiles.map((p) => evaluate(job, p, ctx));
  const matches = results.filter((r): r is Extract<Evaluation, { decision: 'MATCH' }> => r.decision === 'MATCH');
  if (matches.length === 0) {
    const first = results[0] as Extract<Evaluation, { decision: 'REJECT' }>;
    return { ...first, matchedProfiles: [] };
  }
  const best = matches.reduce((a, b) => (b.score * b.confidence > a.score * a.confidence ? b : a));
  return { ...best, matchedProfiles: matches.map((m) => m.profileId) };
}
