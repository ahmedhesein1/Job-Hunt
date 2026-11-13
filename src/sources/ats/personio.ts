import { XMLParser } from 'fast-xml-parser';
import type { ExternalJob } from '../contract';
import { isoOrUndefined, obj, str } from '../parse-utils';
import type { BoardRef } from './common';

/**
 * Personio public job XML (official, no credentials; verified 2026-11-11):
 * GET https://{company}.jobs.personio.de/xml?language=en (or .com) → <workzag-jobs><position>….
 * There is no URL or remote field: the posting URL is /job/{id}, and an office named
 * "Remote" marks remote roles. `createdAt` may lack the offset colon (+0200).
 */
export function personioHost(board: BoardRef): string {
  return `${board.token}.jobs.personio.${board.region === 'com' ? 'com' : 'de'}`;
}

export function personioUrl(board: BoardRef): string {
  return `https://${personioHost(board)}/xml?language=en`;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
  isArray: (name) => name === 'position' || name === 'office' || name === 'jobDescription',
});

export function personioItems(xml: unknown): unknown[] | undefined {
  if (typeof xml !== 'string') return undefined;
  const root = obj(obj(parser.parse(xml))?.['workzag-jobs']);
  if (!root) return xml.includes('workzag-jobs') ? [] : undefined;
  return Array.isArray(root.position) ? root.position : [];
}

/** "2026-01-19T14:19:08+0200" → add the offset colon JS Date expects. */
function personioDate(value: unknown): string | undefined {
  const s = str(value);
  return isoOrUndefined(s?.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

const YEARS: Record<string, number> = { '1-2': 1, '2-5': 2, '5-7': 5, '7-10': 7, '10-15': 10, 'gt-15': 15 };

export function parsePersonioJob(item: unknown, board: BoardRef): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  const id = str(j.id);
  const title = str(j.name);
  if (!id || !title) return undefined;
  const url = `https://${personioHost(board)}/job/${id}?language=en`;
  const offices = [str(j.office), ...(Array.isArray(obj(j.additionalOffices)?.office) ? (obj(j.additionalOffices)?.office as unknown[]).map(str) : [])].filter(
    (o): o is string => Boolean(o),
  );
  const physical = offices.filter((o) => !/^(remote|hybrid)$/i.test(o));
  const sections = (Array.isArray(obj(j.jobDescriptions)?.jobDescription) ? (obj(j.jobDescriptions)?.jobDescription as unknown[]) : [])
    .map((d) => `<h3>${str(obj(d)?.name) ?? ''}</h3>${str(obj(d)?.value) ?? ''}`)
    .join('');
  const years = YEARS[str(j.yearsOfExperience) ?? ''];
  return {
    sourceId: 'company-boards',
    sourceJobId: `personio:${board.token}:${id}`,
    title,
    company: board.company ?? str(j.subcompany) ?? board.token,
    location: offices.join('; ') || undefined,
    remote: offices.some((o) => /^remote$/i.test(o)) ? true : physical.length > 0 && !offices.some((o) => /remote|hybrid/i.test(o)) ? false : undefined,
    description: (sections + (years ? `<p>${years}+ years of experience</p>` : '')) || undefined,
    descriptionIsHtml: true,
    seniorityHints: str(j.seniority) ? [String(j.seniority)] : [],
    applyUrl: url,
    sourceUrl: url,
    employerUrl: url,
    publishedAt: personioDate(j.createdAt),
    via: 'Personio',
  };
}
