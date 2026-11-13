import { XMLParser } from 'fast-xml-parser';
import type { ExternalJob } from '../contract';
import { isoOrUndefined, obj, str } from '../parse-utils';
import type { BoardRef } from './common';

/**
 * Teamtailor career-site RSS (official, keyless; verified 2026-11-11):
 * GET https://{company}.teamtailor.com/jobs.rss (first 100 items). `description` is
 * entity-escaped HTML, `pubDate` RFC-822, `remoteStatus` none|hybrid|fully, and
 * locations live in the tt: namespace.
 */
export function teamtailorUrl(board: BoardRef): string {
  return `https://${board.token}.teamtailor.com/jobs.rss`;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === 'item' || name === 'location',
});

export function teamtailorItems(xml: unknown): unknown[] | undefined {
  if (typeof xml !== 'string') return undefined;
  const channel = obj(obj(obj(parser.parse(xml))?.rss)?.channel);
  if (!channel) return undefined;
  return Array.isArray(channel.item) ? channel.item : [];
}

export function parseTeamtailorJob(item: unknown, board: BoardRef): ExternalJob | undefined {
  const j = obj(item);
  if (!j) return undefined;
  const title = str(j.title);
  const link = str(j.link);
  if (!title || !link) return undefined;
  const locations = (Array.isArray(obj(j.locations)?.location) ? (obj(j.locations)?.location as unknown[]) : [])
    .map((l) => [str(obj(l)?.city) ?? str(obj(l)?.name), str(obj(l)?.country)].filter(Boolean).join(', '))
    .filter(Boolean);
  const remoteStatus = str(j.remoteStatus)?.toLowerCase();
  const id = /\/jobs\/(\d+)/.exec(link)?.[1];
  return {
    sourceId: 'company-boards',
    sourceJobId: `teamtailor:${board.token}:${id ?? str(j.guid) ?? link}`,
    title,
    company: board.company ?? board.token,
    location: locations.join('; ') || (remoteStatus === 'fully' ? 'Remote' : undefined),
    remote: remoteStatus === 'fully' || remoteStatus === 'remote' ? true : remoteStatus === 'none' || remoteStatus === 'hybrid' ? false : undefined,
    description: str(j.description),
    descriptionIsHtml: true,
    applyUrl: link,
    sourceUrl: link,
    employerUrl: link,
    publishedAt: isoOrUndefined(j.pubDate),
    via: 'Teamtailor',
  };
}
