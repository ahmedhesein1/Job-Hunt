import { normalizeForMatch } from './skills';
import { sha256Hex } from './url';

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'l.l.c', 'ltd', 'limited', 'gmbh', 'ag', 'corp', 'corporation', 'co', 'company',
  'plc', 'sa', 's.a', 'sas', 'bv', 'b.v', 'nv', 'pvt', 'private', 'pty', 'sarl', 'srl', 'oy', 'ab', 'as', 'llp',
  'sae', 's.a.e',
]);

/** Normalised company identity used for mutes and fingerprints. */
export function companyKey(company: string): string {
  const words = normalizeForMatch(company)
    .replace(/[()[\],&'"’!?:;|]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/\.$/, ''))
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1] as string)) words.pop();
  return words.join(' ');
}

/** Superficial title normalisation. Seniority words are kept: merging "Senior" with "Junior" is unsafe (§9). */
export function normalizeTitle(title: string): string {
  return normalizeForMatch(title)
    .replace(/node\.?\s?js/g, 'nodejs')
    .replace(/nest\.?\s?js/g, 'nestjs')
    .replace(/back\s?end/g, 'backend')
    .replace(/\bsr\b\.?/g, 'senior')
    .replace(/\bjr\b\.?/g, 'junior')
    .replace(/[()[\],/|:;!?'"’–—.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeScope(scope: string): string {
  return normalizeForMatch(scope).replace(/[()[\],]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** §9 fingerprint: company + title + location/remote scope. */
export function fingerprint(company: string, title: string, scope: string): string {
  return sha256Hex(`${companyKey(company)}|${normalizeTitle(title)}|${normalizeScope(scope)}`).slice(0, 32);
}

export function urlHash(canonicalUrl: string): string {
  return sha256Hex(canonicalUrl).slice(0, 32);
}

export interface DedupeCandidate {
  publishedAt?: string | undefined;
  requisitionId?: string | undefined;
}

const SAME_POSTING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A fingerprint match is a heuristic, not proof (§9). Require a second signal: the
 * same requisition ID, or publish dates within two weeks of each other. Differing
 * requisition IDs or far-apart dates mean different postings.
 */
export function fingerprintMatchIsDuplicate(existing: DedupeCandidate, candidate: DedupeCandidate): boolean {
  if (existing.requisitionId && candidate.requisitionId) return existing.requisitionId === candidate.requisitionId;
  if (existing.publishedAt && candidate.publishedAt) {
    const diff = Math.abs(Date.parse(existing.publishedAt) - Date.parse(candidate.publishedAt));
    return Number.isFinite(diff) && diff <= SAME_POSTING_WINDOW_MS;
  }
  // One side lacks a date: same company+title+scope seen recently (dedupe keys expire
  // after 60 days) is treated as a duplicate with medium confidence.
  return true;
}
