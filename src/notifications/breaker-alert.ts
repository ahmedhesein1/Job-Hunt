import { putTextNotification } from '../data/outbox';
import type { BreakerTransition } from '../scraping/circuit-breaker';
import { escapeHtml } from './formatting';

/** Telegram message for a source breaker state change (one per transition, §5.6). */
export async function notifyBreakerTransition(label: string, transition: BreakerTransition, nowMs: number): Promise<void> {
  const icon = transition.to === 'CLOSED' ? '✅' : '⚠️';
  await putTextNotification(
    `breaker:${label}:${transition.to}:${nowMs}`,
    `${icon} <b>${escapeHtml(label)}</b>: ${escapeHtml(transition.message)}`,
    nowMs,
  );
}
