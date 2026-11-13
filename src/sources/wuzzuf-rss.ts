import { XMLParser } from 'fast-xml-parser';
import { limits } from '../../config/limits';
import { validatorsFrom } from '../scraping/http-client';
import { parsePeriod } from '../core/salary';
import type { AdapterContext, ExternalJob, FetchResult, RawSalary, SourceAdapter } from './contract';
import { isoOrUndefined, obj, str } from './parse-utils';

/**
 * Wuzzuf official RSS feed (verified 2026-11-11; linked as "RSS" in the site footer).
 * ~15 MB / ~5,000 items, Cache-Control max-age=14400, Last-Modified (no ETag).
 * Items carry CDATA fields: title, link, guid, pubDate (RFC-1123), source (company),
 * description and job_requirements (plain text), salary, experience ("2-4 years"),
 * career_level, job_type, area. Terms: personal, non-commercial use; no redistribution.
 *
 * The body is streamed and each <item> is parsed on its own, so memory stays bounded by
 * one item plus the stream buffer (§5.2).
 */
const FEED_URL = 'https://wuzzuf.net/feeds/all-jobs.xml';
const MAX_ITEM_CHARS = 200_000;

const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, trimValues: true, htmlEntities: true });

/** Yields raw `<item>…</item>` strings from a streamed RSS body. */
export async function* streamRssItems(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    for (;;) {
      const start = buffer.search(/<item[\s>]/i);
      if (start < 0) {
        // Keep only a tail long enough to contain a split "<item" tag.
        buffer = buffer.slice(-16);
        break;
      }
      const end = buffer.indexOf('</item>', start);
      if (end < 0) {
        buffer = buffer.slice(start);
        if (buffer.length > MAX_ITEM_CHARS) throw new Error('RSS item exceeds size limit');
        break;
      }
      yield buffer.slice(start, end + '</item>'.length);
      buffer = buffer.slice(end + '</item>'.length);
    }
  }
}

/** Country from the listing slug, e.g. "...-Sharqia-Egypt" or "...-Riyadh-Saudi-Arabia". */
const SLUG_COUNTRIES: Array<[RegExp, string]> = [
  [/-Egypt$/i, 'Egypt'],
  [/-Saudi-Arabia$/i, 'Saudi Arabia'],
  [/-United-Arab-Emirates$/i, 'United Arab Emirates'],
  [/-Qatar$/i, 'Qatar'],
  [/-Kuwait$/i, 'Kuwait'],
  [/-Bahrain$/i, 'Bahrain'],
  [/-Oman$/i, 'Oman'],
  [/-Jordan$/i, 'Jordan'],
];

/** "Salary: 15000 to 20000 EGP Per Month" / "Salary: 15000 EGP Per Month" / "Salary: Negotiable". */
export function parseWuzzufSalary(value: string | undefined): RawSalary | undefined {
  const m = value && /([\d,.]+)\s*(?:to\s*([\d,.]+)\s*)?([A-Z]{3})\s*per\s*(hour|day|week|month|year)/i.exec(value);
  if (!m) return undefined;
  const n = (s: string | undefined) => (s ? Number(s.replace(/,/g, '')) : undefined);
  return { min: n(m[1]), max: n(m[2]) ?? n(m[1]), currency: m[3], period: parsePeriod(m[4]), origin: 'Wuzzuf' };
}

/** Career level → seniority hint. "Experienced (Non-Manager)" is left to the years rule. */
function levelHint(level: string | undefined, jobType: string | undefined): string[] {
  if (jobType && /intern/i.test(jobType)) return ['intern'];
  if (!level) return [];
  if (/entry|student/i.test(level)) return ['entry level'];
  if (/manager|management|director|executive/i.test(level) && !/non-manager/i.test(level)) return ['senior'];
  return [];
}

export function parseWuzzufItem(xml: string): ExternalJob | undefined {
  const parsed = obj(obj(parser.parse(xml))?.item);
  if (!parsed) return undefined;
  const link = str(parsed.link);
  const title = str(parsed.title);
  if (!link || !title || !link.startsWith('https://wuzzuf.net/')) return undefined;
  const country = SLUG_COUNTRIES.find(([re]) => re.test(new URL(link).pathname))?.[1];
  const area = str(parsed.area);
  const experience = str(parsed.experience);
  const body = [
    str(parsed.description),
    str(parsed.job_requirements),
    // "2-4 years" → read by the years-of-experience rule like any description sentence.
    experience ? `Experience: ${experience} of experience.` : undefined,
  ].filter(Boolean);
  return {
    sourceId: 'wuzzuf',
    sourceJobId: str(parsed.guid) ?? link,
    title,
    company: str(parsed.source) ?? 'Unknown company',
    location: [area, country].filter(Boolean).join(', ') || undefined,
    countryCode: country === 'Egypt' ? 'EG' : undefined,
    description: body.join('\n') || undefined,
    descriptionIsHtml: false,
    seniorityHints: levelHint(str(parsed.career_level), str(parsed.job_type)),
    applyUrl: link,
    sourceUrl: link,
    publishedAt: isoOrUndefined(parsed.pubDate),
    salary: parseWuzzufSalary(str(parsed.salary)),
    via: 'Wuzzuf',
  };
}

export const wuzzufAdapter: SourceAdapter = {
  id: 'wuzzuf',
  async fetch(ctx: AdapterContext): Promise<FetchResult> {
    const result = await ctx.fetcher.fetch(
      {
        url: FEED_URL,
        allowedHosts: ctx.policy.allowedHosts,
        expect: 'xml',
        validators: ctx.validators,
        maxBytes: limits.http.maxStreamBytes,
        respectRobots: ctx.policy.respectRobots,
      },
      async (res) => {
        const jobs: ExternalJob[] = [];
        let malformed = 0;
        let seen = 0;
        for await (const item of streamRssItems(res.chunks())) {
          seen += 1;
          try {
            const job = parseWuzzufItem(item);
            if (!job) malformed += 1;
            else if (!job.publishedAt || Date.parse(job.publishedAt) >= ctx.sinceMs) jobs.push(job);
          } catch {
            malformed += 1;
          }
        }
        return { jobs, malformed, seen, validators: validatorsFrom(res.headers) };
      },
    );
    if (result.kind === 'not-modified') return { kind: 'unchanged', validators: ctx.validators };
    return { kind: 'ok', ...result.value };
  },
};
