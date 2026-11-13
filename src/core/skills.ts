/**
 * Whole-word term and skill matching (§6.3). `Java` must not match `JavaScript`,
 * `Go` must not match `Google`. Works for Latin and Arabic text.
 */

/** Lowercase, NFKC, hyphen/underscore → space, collapsed whitespace. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐-―_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const regexCache = new Map<string, RegExp>();

/** Regex for a normalised term bounded by non-letter/non-digit characters. */
export function termRegex(term: string): RegExp {
  const normalized = normalizeForMatch(term);
  let re = regexCache.get(normalized);
  if (!re) {
    const body = escapeRegex(normalized).replace(/ /g, '\\s+');
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u');
    regexCache.set(normalized, re);
  }
  return re;
}

/** `text` must already be normalised with normalizeForMatch. */
export function containsTerm(normalizedText: string, term: string): boolean {
  return termRegex(term).test(normalizedText);
}

export function matchingTerms(normalizedText: string, terms: readonly string[]): string[] {
  return terms.filter((t) => containsTerm(normalizedText, t));
}

/** Canonical skill → aliases. Keys are the names used in profiles. */
export const skillAliases: Record<string, string[]> = {
  node: ['node', 'nodejs', 'node.js', 'node js'],
  typescript: ['typescript'],
  javascript: ['javascript', 'ecmascript'],
  nestjs: ['nestjs', 'nest.js', 'nest js'],
  express: ['express.js', 'expressjs'],
  postgresql: ['postgres', 'postgresql', 'psql'],
  mysql: ['mysql'],
  mongodb: ['mongodb', 'mongo'],
  redis: ['redis'],
  docker: ['docker'],
  kubernetes: ['kubernetes', 'k8s'],
  aws: ['aws', 'amazon web services'],
  kafka: ['kafka'],
  rabbitmq: ['rabbitmq'],
  grpc: ['grpc'],
  graphql: ['graphql'],
};

/**
 * `ts` is only accepted where context is unambiguous: as a source tag, or paired with
 * JavaScript/Node like "JS/TS", "TS/JS", "Node/TS".
 */
const TS_CONTEXT = /(?<![\p{L}\p{N}])(?:(?:js|javascript|node(?:\.js)?)\s*\/\s*ts|ts\s*\/\s*(?:js|javascript|node(?:\.js)?))(?![\p{L}\p{N}])/u;

export function extractSkills(normalizedText: string, normalizedTags: readonly string[] = []): Set<string> {
  const found = new Set<string>();
  const tagText = normalizedTags.join(' | ');
  for (const [skill, aliases] of Object.entries(skillAliases)) {
    if (aliases.some((a) => containsTerm(normalizedText, a) || containsTerm(tagText, a))) found.add(skill);
  }
  if (!found.has('typescript') && (normalizedTags.includes('ts') || TS_CONTEXT.test(normalizedText))) {
    found.add('typescript');
  }
  return found;
}
