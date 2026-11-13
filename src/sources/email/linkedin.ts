import { decodeEntities } from '../../core/normalize';
import type { ExternalJob } from '../contract';

/**
 * Parser for the user's own LinkedIn job-alert emails (§12). We never touch LinkedIn's
 * website; we only read alert emails the user subscribed to.
 *
 * IMPORTANT: §12 requires parsers built from saved examples of the user's own alert
 * emails. LinkedIn's alert HTML is not documented, so this parser relies on the stable
 * part — job links of the form /jobs/view/<id> — and reads the title from the link text
 * and "Company · Location" from the text that follows. Validate it against saved
 * fixtures (test/fixtures/linkedin-alert-*.html) before enabling the source.
 */
const JOB_LINK = /<a\b[^>]*href="(https:\/\/(?:www\.)?linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^"/]*?-)?(\d{6,})[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export interface LinkedInAlertJob extends ExternalJob {
  sourceId: 'linkedin-email';
}

export function parseLinkedInAlert(html: string, receivedAtIso: string): { jobs: LinkedInAlertJob[]; malformed: number } {
  const byId = new Map<string, LinkedInAlertJob>();
  let malformed = 0;
  const matches = [...html.matchAll(JOB_LINK)];
  for (const [i, match] of matches.entries()) {
    const id = match[2] as string;
    const linkText = textOf(match[3] ?? '');
    const existing = byId.get(id);
    // Alerts link each job several times (logo, title, button). Keep the first link whose
    // text looks like a title.
    if (existing || !linkText || /^(view job|apply|see all jobs)$/i.test(linkText) || linkText.length > 200) continue;
    const nextStart = (match.index ?? 0) + match[0].length;
    const nextEnd = matches[i + 1]?.index ?? Math.min(html.length, nextStart + 2000);
    const following = textOf(html.slice(nextStart, nextEnd)).slice(0, 300);
    const [company, location] = following.split(/\s+[·•]\s+/);
    if (!company) {
      malformed += 1;
      continue;
    }
    const url = `https://www.linkedin.com/jobs/view/${id}/`;
    byId.set(id, {
      sourceId: 'linkedin-email',
      sourceJobId: id,
      title: linkText,
      company: company.trim().slice(0, 120),
      location: location?.split(/\s{2,}|\n/)[0]?.trim().slice(0, 120),
      // No description in alert emails: skills/experience stay UNKNOWN (§12).
      applyUrl: url,
      sourceUrl: url,
      publishedAt: receivedAtIso,
      publishedAtReliable: false,
      via: 'LinkedIn alert',
    });
  }
  return { jobs: [...byId.values()], malformed };
}
