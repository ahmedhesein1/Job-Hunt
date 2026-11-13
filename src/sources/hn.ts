import { decodeEntities, htmlToText } from '../core/normalize';
import { parseAtsUrl } from '../core/url';
import { DAY_MS, HOUR_MS } from '../lib/time';
import type { AdapterContext, ExternalJob, FetchResult, SourceAdapter } from './contract';
import { isoOrUndefined, num, obj, str } from './parse-utils';

/**
 * Hacker News "Who is hiring?" via the official Algolia HN API (verified 2026-11-10).
 * Story: search_by_date?tags=story,author_whoishiring (also returns "Who wants to be
 * hired?" — filter by title). Comments: tags=comment,story_<id> with
 * numericFilters=created_at_i><watermark>; keep only top-level (parent_id === story_id).
 * Cadence (§4): hourly during the first 72 h of the monthly thread, then daily.
 */
const API = 'https://hn.algolia.com/api/v1/search_by_date';
const HIRING_TITLE = /^Ask HN: Who is hiring\?/i;
const MAX_PAGES = 5;
const ROLE_WORDS = /engineer|developer|backend|back-end|node|full[ -]?stack|software|programmer|sre|devops|platform|api/i;
const LOCATION_WORDS = /remote|onsite|on-site|hybrid|relocat|visa|\b[A-Z]{2}\b|,/;
const MONEY = /[$€£]\s?\d|\d+\s?k\b|salary|equity/i;
const EMPLOYMENT = /full[ -]?time|part[ -]?time|contract|freelance|intern(ship)?|permanent/i;

export function parseHnComment(item: unknown, storyId: number): ExternalJob | undefined {
  const c = obj(item);
  if (!c) return undefined;
  const id = str(c.objectID);
  const html = str(c.comment_text);
  if (!id || !html) return undefined;
  if (num(c.parent_id) !== storyId) return undefined;

  const firstLine = decodeEntities(html.split(/<p>|\n/i)[0] ?? '').replace(/<[^>]+>/g, '').trim();
  const segments = firstLine.split('|').map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return undefined;
  const company = segments[0] as string;
  const rest = segments.slice(1).filter((s) => !/^https?:\/\//i.test(s) && !MONEY.test(s));
  // Prefer a segment naming a role; never use a location or employment-type segment as
  // the title ("Acme | Dallas, TX | Full-time" has no identifiable role → skipped).
  const title = rest.find((s) => ROLE_WORDS.test(s)) ?? rest.find((s) => !LOCATION_WORDS.test(s) && !EMPLOYMENT.test(s));
  if (!title) return undefined;
  const location = rest.filter((s) => s !== title && LOCATION_WORDS.test(s)).join(' | ') || undefined;
  const lowerLine = firstLine.toLowerCase();
  const remote = /\bremote\b/.test(lowerLine) ? true : /\bonsite\b|\bon-site\b/.test(lowerLine) ? false : undefined;

  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => decodeEntities(m[1] ?? ''));
  const ats = hrefs.find((h) => parseAtsUrl(h));
  const firstHttps = hrefs.find((h) => h.startsWith('https://'));
  const itemUrl = `https://news.ycombinator.com/item?id=${id}`;

  return {
    sourceId: 'hn',
    sourceJobId: id,
    title: title.slice(0, 200),
    company: company.slice(0, 120),
    location,
    remote,
    description: htmlToText(html),
    descriptionIsHtml: false,
    applyUrl: ats ?? firstHttps ?? itemUrl,
    sourceUrl: itemUrl,
    employerUrl: ats,
    publishedAt: isoOrUndefined(c.created_at),
    via: 'Hacker News',
  };
}

interface StoryInfo {
  id: number;
  createdAtMs: number;
}

export const hnAdapter: SourceAdapter = {
  id: 'hn',
  async fetch(ctx: AdapterContext): Promise<FetchResult> {
    const storyResult = await ctx.fetcher.fetch(
      { url: `${API}?tags=story,author_whoishiring&hitsPerPage=10`, allowedHosts: ctx.policy.allowedHosts, expect: 'json' },
      async (res) => JSON.parse(await res.text()) as unknown,
    );
    if (storyResult.kind === 'not-modified') return { kind: 'skipped', reason: 'story search unchanged' };
    const hits = obj(storyResult.value)?.hits;
    if (!Array.isArray(hits)) throw new Error('HN story search has no hits');
    const story = hits
      .map(obj)
      .filter((h): h is Record<string, unknown> => Boolean(h && HIRING_TITLE.test(str(h.title) ?? '')))
      .map((h): StoryInfo => ({ id: num(h.story_id) ?? Number(str(h.objectID)), createdAtMs: (num(h.created_at_i) ?? 0) * 1000 }))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
    if (!story || !Number.isFinite(story.id)) return { kind: 'skipped', reason: 'no current "Who is hiring?" thread' };

    // §4: hourly for the first 72 h of the thread, then daily.
    const sameStory = Number(ctx.cursor.storyId) === story.id;
    const lastScanAt = Number(ctx.cursor.lastScanAt ?? 0);
    if (sameStory && ctx.nowMs - story.createdAtMs > 72 * HOUR_MS && ctx.nowMs - lastScanAt < DAY_MS - 10 * 60_000) {
      return { kind: 'skipped', reason: 'thread older than 72 h; daily cadence' };
    }

    // Only fetch comments newer than the last one we processed (no repeated full scans).
    const watermark = sameStory ? Number(ctx.cursor.lastCommentAt ?? 0) : 0;
    const jobs: ExternalJob[] = [];
    let malformed = 0;
    let seen = 0;
    let newest = watermark;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ tags: `comment,story_${story.id}`, hitsPerPage: '100', page: String(page) });
      if (watermark > 0) params.set('numericFilters', `created_at_i>${watermark}`);
      const res = await ctx.fetcher.fetch(
        { url: `${API}?${params}`, allowedHosts: ctx.policy.allowedHosts, expect: 'json' },
        async (r) => JSON.parse(await r.text()) as unknown,
      );
      if (res.kind === 'not-modified') break;
      const body = obj(res.value);
      const comments = Array.isArray(body?.hits) ? (body.hits as unknown[]) : [];
      const topLevel = comments.filter((c) => num(obj(c)?.parent_id) === story.id);
      seen += topLevel.length;
      for (const c of comments) newest = Math.max(newest, num(obj(c)?.created_at_i) ?? 0);
      // Free-form posts that do not follow "Company | Role | …" are skipped, not malformed;
      // only items that throw while parsing count toward the malformed threshold.
      for (const c of topLevel) {
        try {
          const job = parseHnComment(c, story.id);
          if (job) jobs.push(job);
        } catch {
          malformed += 1;
        }
      }
      const nbPages = num(body?.nbPages) ?? 0;
      if (page + 1 >= nbPages) break;
    }
    return {
      kind: 'ok',
      jobs,
      validators: {},
      malformed,
      seen,
      cursor: { storyId: story.id, lastCommentAt: newest, lastScanAt: ctx.nowMs },
    };
  },
};
