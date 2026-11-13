import { limits } from '../../config/limits';

/** §5.5 response classification. */
export type Outcome =
  | { type: 'OK' }
  | { type: 'NOT_MODIFIED' }
  | { type: 'CLIENT_BUG'; status: number }
  | { type: 'AUTH'; status: number }
  | { type: 'FORBIDDEN'; status: number }
  | { type: 'CHALLENGE'; detail: string }
  | { type: 'NOT_FOUND'; status: number }
  | { type: 'RATE_LIMITED'; retryAfterMs: number | undefined }
  | { type: 'TRANSIENT'; status?: number | undefined; detail: string }
  | { type: 'BAD_CONTENT'; detail: string };

export type OutcomeType = Outcome['type'];

/** Outcomes that may be retried within the same run (idempotent GET only). */
export function isRetryableInRun(outcome: Outcome): boolean {
  return outcome.type === 'TRANSIENT';
}

/** Outcomes that reflect the host's health and update the domain gate breaker. */
export function isHostLevel(outcome: Outcome): boolean {
  return ['OK', 'NOT_MODIFIED', 'RATE_LIMITED', 'TRANSIENT', 'FORBIDDEN', 'CHALLENGE'].includes(outcome.type);
}

/** Parses `Retry-After` as delta-seconds or an HTTP date. Returns ms from now. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - nowMs);
}

const CHALLENGE_MARKERS = [
  /captcha/i,
  /cf-chl|challenge-platform|cf_chl_opt/i,
  /attention required!? \| cloudflare/i,
  /just a moment\.\.\./i,
  /access denied|request blocked|bot detection|are you a robot|unusual traffic/i,
  /please (?:log ?in|sign ?in) to continue/i,
];

/** Detects CAPTCHA / anti-bot / login-wall pages (§5.5 last row). */
export function looksLikeChallenge(headers: Headers, bodySample: string): string | undefined {
  if (headers.get('cf-mitigated')?.toLowerCase() === 'challenge') return 'cf-mitigated: challenge';
  for (const marker of CHALLENGE_MARKERS) {
    if (marker.test(bodySample)) return `body matched ${marker.source}`;
  }
  return undefined;
}

const CHALLENGE_TITLES = /just a moment|attention required|access denied|are you a robot|security check|captcha|verify you are human|sign in|log in|login/i;

/**
 * Stricter check for real HTML pages: career pages often embed reCAPTCHA for their
 * application form, so only the challenge header or a challenge-style page title counts.
 */
export function looksLikeChallengePage(headers: Headers, html: string): string | undefined {
  if (headers.get('cf-mitigated')?.toLowerCase() === 'challenge') return 'cf-mitigated: challenge';
  const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html)?.[1]?.trim();
  return title && CHALLENGE_TITLES.test(title) ? `page title "${title.slice(0, 60)}"` : undefined;
}

export function classifyStatus(status: number, headers: Headers, nowMs: number): Outcome {
  if (status === 200 || status === 203) return { type: 'OK' };
  if (status === 304) return { type: 'NOT_MODIFIED' };
  if (status === 401 || status === 407) return { type: 'AUTH', status };
  if (status === 403) return { type: 'FORBIDDEN', status };
  if (status === 404 || status === 410) return { type: 'NOT_FOUND', status };
  // 999 is LinkedIn's "request denied" throttling response: a rate limit, not a server fault.
  if (status === 429 || status === 999) return { type: 'RATE_LIMITED', retryAfterMs: parseRetryAfter(headers.get('retry-after'), nowMs) };
  if (status === 503 && headers.get('retry-after')) {
    // 503 + Retry-After is a load-shedding signal; treat it like a rate limit.
    return { type: 'RATE_LIMITED', retryAfterMs: parseRetryAfter(headers.get('retry-after'), nowMs) };
  }
  if (status >= 500) return { type: 'TRANSIENT', status, detail: `HTTP ${status}` };
  if (status >= 400) return { type: 'CLIENT_BUG', status };
  return { type: 'TRANSIENT', status, detail: `Unexpected HTTP ${status}` };
}

/**
 * §5.5: ~1 s, 2 s, 4 s plus random jitter, strictly bounded. `attempt` is 0-based.
 * Never shorter than the host's minimum gap.
 */
export function backoffDelayMs(attempt: number, minGapMs: number, random: () => number = Math.random): number {
  const base = limits.http.backoffBaseMs * 2 ** attempt;
  const jittered = base + random() * base;
  return Math.min(limits.http.backoffMaxMs, Math.max(minGapMs, Math.round(jittered)));
}
