/** Small defensive readers for untrusted JSON (§8 step 7: one bad item never aborts a feed). */
export function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter((v): v is string => v !== undefined) : [];
}

export function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function epochSecondsToIso(value: unknown): string | undefined {
  const n = num(value);
  return n !== undefined && n > 0 ? new Date(n * 1000).toISOString() : undefined;
}

export function epochMsToIso(value: unknown): string | undefined {
  const n = num(value);
  return n !== undefined && n > 0 ? new Date(n).toISOString() : undefined;
}

export function isoOrUndefined(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function publishedBefore(iso: string | undefined, sinceMs: number): boolean {
  return iso !== undefined && Date.parse(iso) < sinceMs;
}

/** Maps a list with a per-item parser, counting items that fail instead of throwing. */
export function parseItems<T>(items: unknown[], parse: (item: unknown) => T | undefined): { jobs: T[]; malformed: number } {
  const jobs: T[] = [];
  let malformed = 0;
  for (const item of items) {
    try {
      const parsed = parse(item);
      if (parsed === undefined) malformed += 1;
      else jobs.push(parsed);
    } catch {
      malformed += 1;
    }
  }
  return { jobs, malformed };
}

export async function parseJson(text: string): Promise<unknown> {
  return JSON.parse(text) as unknown;
}
