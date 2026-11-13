import { parse, type HTMLElement } from 'node-html-parser';
import type { ExternalJob } from '../contract';
import { cleanText } from './search-page';

/**
 * Parser for LinkedIn's logged-out job page fragment
 * (`/jobs-guest/jobs/api/jobPosting/<id>`): the description and the criteria list
 * (seniority level, employment type) that search cards do not carry.
 */
const DETAIL_BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';

export function buildLinkedInJobDetailUrl(jobId: string): string {
  if (!/^\d{6,}$/.test(jobId)) throw new Error(`invalid LinkedIn job ID: ${jobId}`);
  return `${DETAIL_BASE}${jobId}`;
}

export interface LinkedInJobDetail {
  /** Description as HTML (the pipeline converts it to text). */
  descriptionHtml: string;
  /** Hint for the seniority classifier, from LinkedIn's "Seniority level". */
  seniorityHint?: string | undefined;
  /** Normalised "Employment type": full-time, part-time, contract… */
  employmentType?: string | undefined;
}

/** LinkedIn seniority levels → hints classifySeniority understands. */
const SENIORITY_HINTS: Record<string, string | undefined> = {
  internship: 'Internship',
  'entry level': 'Entry level',
  associate: 'Junior',
  'mid-senior level': 'Mid-Senior level',
  director: 'Director',
  executive: 'Executive',
  'not applicable': undefined,
};

const EMPLOYMENT_TYPES: Record<string, string> = {
  'full-time': 'full-time',
  'part-time': 'part-time',
  contract: 'contract',
  temporary: 'temporary',
  internship: 'internship',
  volunteer: 'volunteer',
  other: 'other',
};

/** Description shorter than this is treated as missing (a stub, not a job description). */
const MIN_DESCRIPTION_CHARS = 40;

function criteria(root: HTMLElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of root.querySelectorAll('.description__job-criteria-item')) {
    const key = cleanText(item.querySelector('.description__job-criteria-subheader')?.text).toLowerCase();
    const value = cleanText(item.querySelector('.description__job-criteria-text')?.text);
    if (key && value) out.set(key, value);
  }
  return out;
}

/** The detail fields, or undefined when the page holds no job description (wrong page). */
export function parseLinkedInJobDetail(html: string): LinkedInJobDetail | undefined {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: false, style: false, noscript: false, template: false, pre: true },
  });
  const description = root.querySelector('.show-more-less-html__markup') ?? root.querySelector('.description__text');
  if (!description || cleanText(description.text).length < MIN_DESCRIPTION_CHARS) return undefined;
  const c = criteria(root);
  const level = c.get('seniority level')?.toLowerCase();
  const type = c.get('employment type')?.toLowerCase();
  return {
    descriptionHtml: description.innerHTML.trim(),
    seniorityHint: level !== undefined ? SENIORITY_HINTS[level] : undefined,
    employmentType: type !== undefined ? EMPLOYMENT_TYPES[type] : undefined,
  };
}

/** The job with the detail page's description, seniority and employment type added. */
export function withJobDetail(job: ExternalJob, detail: LinkedInJobDetail): ExternalJob {
  return {
    ...job,
    description: detail.descriptionHtml,
    descriptionIsHtml: true,
    seniorityHints: detail.seniorityHint ? [detail.seniorityHint] : job.seniorityHints,
    employmentType: detail.employmentType ?? job.employmentType,
  };
}
