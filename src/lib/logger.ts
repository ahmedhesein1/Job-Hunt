/**
 * Structured JSON logger. Never logs secrets: keys that look sensitive are redacted,
 * and long strings (job descriptions, email bodies) are truncated (§12, §14).
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /token|secret|password|authorization|cookie|refresh|apikey|api_key|body|description|html/i;
const MAX_STRING = 300;

function minLevel(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (configured === 'silent') return Number.POSITIVE_INFINITY;
  return LEVELS[configured as Level] ?? LEVELS.info;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: sanitize(value.message, depth + 1), stack: value.stack?.split('\n').slice(0, 5).join('\n') };
  }
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1);
  }
  return out;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel()) return;
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...(sanitize(fields ?? {}) as object) });
  // Lambda captures stdout/stderr into CloudWatch Logs.
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};

export const __test = { sanitize };
