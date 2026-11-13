import { createHash } from 'node:crypto';
import type { AtsProvider } from '../../config/sources';

/** §9: tracking parameters stripped from canonical URLs. */
const TRACKING_PARAMS = new Set(['ref', 'refid', 'trackingid', 'gh_src', 'lever-source', 'lever-origin']);

export interface AtsPosting {
  ats: AtsProvider;
  /** Board token / site / job-board name. */
  token: string;
  postingId?: string | undefined;
  /** Provider-specific host variant: Lever EU tenant ('eu') or Personio .com ('com'). */
  region?: 'eu' | 'com' | undefined;
}

function safeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * §4.1 steps 1–3: parse an apply URL *without requesting it* and extract a public board
 * token for a known ATS host. Unknown hosts return undefined.
 */
export function parseAtsUrl(value: string): AtsPosting | undefined {
  const url = safeUrl(value);
  if (!url || url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'job-boards.eu.greenhouse.io') {
    if (parts[0] === 'embed') {
      const token = url.searchParams.get('for');
      return token && TOKEN.test(token) ? { ats: 'greenhouse', token, postingId: url.searchParams.get('token') ?? undefined } : undefined;
    }
    const token = parts[0];
    if (!token || !TOKEN.test(token)) return undefined;
    const postingId = parts[1] === 'jobs' && parts[2] && /^\d+$/.test(parts[2]) ? parts[2] : undefined;
    return { ats: 'greenhouse', token, postingId };
  }
  if (host === 'boards-api.greenhouse.io' && parts[0] === 'v1' && parts[1] === 'boards' && parts[2] && TOKEN.test(parts[2])) {
    return { ats: 'greenhouse', token: parts[2], postingId: parts[4] };
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    const token = parts[0];
    if (!token || !TOKEN.test(token)) return undefined;
    const postingId = parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1]) ? parts[1].toLowerCase() : undefined;
    return { ats: 'lever', token, postingId, region: host === 'jobs.eu.lever.co' ? 'eu' : undefined };
  }
  if (host === 'jobs.ashbyhq.com') {
    const token = parts[0] ? decodeURIComponent(parts[0]) : undefined;
    if (!token || !TOKEN.test(token)) return undefined;
    const postingId = parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1]) ? parts[1].toLowerCase() : undefined;
    return { ats: 'ashby', token, postingId };
  }
  if (host === 'apply.workable.com') {
    // /{account}/j/{shortcode} or /{account}/jobs/view/{shortcode}. "/j/{code}" alone has no account.
    const token = parts[0];
    if (!token || ['j', 'api', 'jobs'].includes(token) || !TOKEN.test(token)) return undefined;
    const code = parts[1] === 'j' ? parts[2] : parts[1] === 'jobs' && parts[2] === 'view' ? parts[3] : undefined;
    return { ats: 'workable', token, postingId: code && /^[A-Z0-9]{6,12}$/i.test(code) ? code.toUpperCase() : undefined };
  }
  const recruitee = /^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/.exec(host);
  if (recruitee?.[1]) {
    const o = parts.indexOf('o');
    const slug = o >= 0 ? parts[o + 1] : undefined;
    return { ats: 'recruitee', token: recruitee[1], postingId: slug && TOKEN.test(slug) ? slug : undefined };
  }
  const teamtailor = /^([a-z0-9][a-z0-9-]*)\.teamtailor\.com$/.exec(host);
  if (teamtailor?.[1] && !['www', 'app', 'support', 'api'].includes(teamtailor[1])) {
    const id = parts[0] === 'jobs' ? /^(\d+)(?:-|$)/.exec(parts[1] ?? '')?.[1] : undefined;
    return { ats: 'teamtailor', token: teamtailor[1], postingId: id };
  }
  const personio = /^([a-z0-9][a-z0-9-]*)\.jobs\.personio\.(de|com)$/.exec(host);
  if (personio?.[1]) {
    const id = parts[0] === 'job' && parts[1] && /^\d+$/.test(parts[1]) ? parts[1] : undefined;
    return { ats: 'personio', token: personio[1], postingId: id, region: personio[2] === 'com' ? 'com' : undefined };
  }
  const bamboo = /^([a-z0-9][a-z0-9-]*)\.bamboohr\.com$/.exec(host);
  if (bamboo?.[1] && !['www', 'api', 'app'].includes(bamboo[1])) {
    // /careers/{id} or /jobs/view.php?id={id}
    const id = parts[0] === 'careers' && parts[1] && /^\d+$/.test(parts[1]) ? parts[1] : (url.searchParams.get('id') ?? undefined);
    return { ats: 'bamboohr', token: bamboo[1], postingId: id && /^\d+$/.test(id) ? id : undefined };
  }
  return undefined;
}

/** Public posting URL for an ATS posting, used as the canonical apply URL. */
export function atsPostingUrl(p: AtsPosting): string | undefined {
  if (!p.postingId) return undefined;
  switch (p.ats) {
    case 'greenhouse':
      return `https://boards.greenhouse.io/${p.token}/jobs/${p.postingId}`;
    case 'lever':
      return `https://jobs${p.region === 'eu' ? '.eu' : ''}.lever.co/${p.token}/${p.postingId}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${p.token}/${p.postingId}`;
    case 'workable':
      return `https://apply.workable.com/${p.token}/j/${p.postingId}`;
    case 'recruitee':
      return `https://${p.token}.recruitee.com/o/${p.postingId}`;
    case 'teamtailor':
      return `https://${p.token}.teamtailor.com/jobs/${p.postingId}`;
    case 'bamboohr':
      return `https://${p.token}.bamboohr.com/careers/${p.postingId}`;
    case 'personio':
      return `https://${p.token}.jobs.personio.${p.region === 'com' ? 'com' : 'de'}/job/${p.postingId}`;
  }
}

const LINKEDIN_JOB = /\/(?:comm\/)?jobs\/view\/(?:[^/]*?-)?(\d{6,})/;

/**
 * §9 canonical apply URL: lowercase host, strip tracking params and fragment, stable
 * LinkedIn job ID URL, and prefer the canonical ATS posting URL when recognised.
 */
export function canonicalizeUrl(value: string): string | undefined {
  const url = safeUrl(value);
  if (!url) return undefined;
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';

  if (/(^|\.)linkedin\.com$/.test(url.hostname)) {
    const id = LINKEDIN_JOB.exec(url.pathname)?.[1] ?? url.searchParams.get('currentJobId') ?? undefined;
    return id && /^\d+$/.test(id) ? `https://www.linkedin.com/jobs/view/${id}/` : undefined;
  }

  const ats = parseAtsUrl(url.toString());
  const atsUrl = ats ? atsPostingUrl(ats) : undefined;
  if (atsUrl) return atsUrl;

  const kept = [...url.searchParams.entries()]
    .filter(([k]) => !k.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  url.protocol = 'https:';
  let out = url.toString();
  if (url.pathname !== '/' && out.endsWith('/') && !url.search) out = out.slice(0, -1);
  return out;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** §9: internal IDs are ≥24 hex chars of SHA-256. */
export function stableId(...parts: string[]): string {
  return sha256Hex(parts.join('\u001f')).slice(0, 24);
}
