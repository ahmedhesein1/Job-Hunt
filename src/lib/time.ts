export const CAIRO_TZ = 'Africa/Cairo';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Injectable clock so tests are deterministic. */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function epochSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** DynamoDB TTL value (Unix epoch seconds) `days` after `fromMs`. */
export function ttlAfterDays(fromMs: number, days: number): number {
  return epochSeconds(fromMs + days * DAY_MS);
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAIRO_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function cairoParts(ms: number): ZonedParts {
  const parts = Object.fromEntries(partsFormatter.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0,
  };
}

/** Calendar day in Cairo, `YYYY-MM-DD`. Used for the instant-alert daily cap. */
export function cairoDayKey(ms: number): string {
  const p = cairoParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Current UTC offset of Cairo in hours (Egypt observes DST, so this is +2 or +3). */
export function cairoUtcOffsetHours(ms: number): number {
  const p = cairoParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  return Math.round((asUtc - truncated) / HOUR_MS);
}

/** True when `ms` falls in [startHour, endHour) Cairo time. Handles windows crossing midnight. */
export function isQuietHours(ms: number, window: { startHour: number; endHour: number }): boolean {
  const { hour } = cairoParts(ms);
  if (window.startHour === window.endHour) return false;
  if (window.startHour < window.endHour) return hour >= window.startHour && hour < window.endHour;
  return hour >= window.startHour || hour < window.endHour;
}

export function relativeAge(fromMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - fromMs);
  if (diff < HOUR_MS) return `${Math.max(1, Math.round(diff / MINUTE_MS))} min ago`;
  if (diff < DAY_MS) return `${Math.round(diff / HOUR_MS)} h ago`;
  return `${Math.round(diff / DAY_MS)} d ago`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
