import { limits } from '../../config/limits';
import type { Outcome } from './retry-policy';

/**
 * §5.6 error-specific circuit breaker. Pure state transitions so the same logic drives
 * both the per-host domain gate and per-source state.
 */
export type BreakerStatus = 'CLOSED' | 'COOLDOWN' | 'OPEN' | 'MANUAL_REVIEW' | 'UNAVAILABLE';

export interface BreakerState {
  status: BreakerStatus;
  consecutive429: number;
  consecutive5xx: number;
  consecutiveNetworkFailures: number;
  breakerEpisodes: number;
  cooldownUntil?: number | undefined;
  pausedReason?: string | undefined;
  pausedAt?: number | undefined;
  /** ≥1. Multiplies the source's minimum interval after repeated 429s. */
  intervalMultiplier: number;
}

export interface BreakerTransition {
  from: BreakerStatus;
  to: BreakerStatus;
  message: string;
}

export function initialBreaker(): BreakerState {
  return { status: 'CLOSED', consecutive429: 0, consecutive5xx: 0, consecutiveNetworkFailures: 0, breakerEpisodes: 0, intervalMultiplier: 1 };
}

/** True if requests are currently not allowed. */
export function isBlocked(state: BreakerState, nowMs: number): boolean {
  if (state.status === 'MANUAL_REVIEW' || state.status === 'UNAVAILABLE') return true;
  return state.cooldownUntil !== undefined && state.cooldownUntil > nowMs;
}

function fmtDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
}

export function applyOutcome(
  previous: BreakerState,
  outcome: Outcome,
  nowMs: number,
  random: () => number = Math.random,
): { state: BreakerState; transition?: BreakerTransition } {
  const s: BreakerState = { ...previous };
  const from = previous.status;
  const jitter = (ms: number) => Math.round(ms * (1 + random() * 0.1));
  let message: string | undefined;

  switch (outcome.type) {
    case 'OK':
    case 'NOT_MODIFIED': {
      // Reset transient counters, but never clear a manual-review pause automatically.
      s.consecutive429 = 0;
      s.consecutive5xx = 0;
      s.consecutiveNetworkFailures = 0;
      s.breakerEpisodes = 0;
      if (s.status !== 'MANUAL_REVIEW' && s.status !== 'UNAVAILABLE') {
        s.status = 'CLOSED';
        s.cooldownUntil = undefined;
        if (from === 'OPEN') message = 'recovered after transient failures';
      }
      break;
    }
    case 'RATE_LIMITED': {
      s.consecutive429 += 1;
      const fallback = limits.breaker.rateLimitBaseCooldownMs * 2 ** (s.consecutive429 - 1);
      const wait = Math.min(limits.http.maxRetryAfterMs, outcome.retryAfterMs ?? fallback);
      s.cooldownUntil = nowMs + jitter(Math.min(wait, limits.breaker.maxPauseMs));
      s.status = 'COOLDOWN';
      if (s.consecutive429 === limits.breaker.rateLimitsBeforeSlowdown) {
        s.intervalMultiplier = Math.min(limits.breaker.maxIntervalMultiplier, s.intervalMultiplier * 2);
        message = `rate-limited ${s.consecutive429}× in a row; polling slowed ×${s.intervalMultiplier}`;
      }
      break;
    }
    case 'TRANSIENT': {
      if (outcome.status !== undefined) s.consecutive5xx += 1;
      else s.consecutiveNetworkFailures += 1;
      const failures = s.consecutive5xx + s.consecutiveNetworkFailures;
      if (failures >= limits.breaker.transientFailuresToOpen) {
        s.breakerEpisodes += 1;
        const pause = Math.min(limits.breaker.maxPauseMs, limits.breaker.firstPauseMs * 2 ** (s.breakerEpisodes - 1));
        s.cooldownUntil = nowMs + jitter(pause);
        s.status = 'OPEN';
        s.consecutive5xx = 0;
        s.consecutiveNetworkFailures = 0;
        message = `${failures} consecutive failures (${outcome.detail}); paused ${fmtDuration(pause)}`;
      }
      break;
    }
    case 'AUTH':
    case 'FORBIDDEN':
    case 'CHALLENGE':
    case 'CLIENT_BUG':
    case 'BAD_CONTENT': {
      // Stop automation; a human must review (§5.6). No evasion.
      s.status = 'MANUAL_REVIEW';
      s.pausedReason =
        outcome.type === 'CHALLENGE' ? `anti-bot challenge (${outcome.detail})`
        : outcome.type === 'BAD_CONTENT' ? `unexpected content (${outcome.detail})`
        : `HTTP ${outcome.status}`;
      s.pausedAt = nowMs;
      if (from !== 'MANUAL_REVIEW') message = `paused for manual review: ${s.pausedReason}`;
      break;
    }
    case 'NOT_FOUND': {
      s.status = 'UNAVAILABLE';
      s.pausedReason = `HTTP ${outcome.status}`;
      s.pausedAt = s.pausedAt ?? nowMs;
      if (from !== 'UNAVAILABLE') message = `feed unavailable (HTTP ${outcome.status})`;
      break;
    }
  }

  // Messages are only produced on real transitions: one warning per change (§5.6).
  return message ? { state: s, transition: { from, to: s.status, message } } : { state: s };
}

/** Manual resume after review (/resume <source>). */
export function resetBreaker(state: BreakerState): BreakerState {
  return { ...initialBreaker(), intervalMultiplier: state.intervalMultiplier };
}
