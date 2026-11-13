import type { AtsProvider } from '../../../config/sources';
import { sources } from '../../../config/sources';
import { validatorsFrom } from '../../scraping/http-client';
import type { Fetcher } from '../../scraping/fetcher';
import type { ExternalJob, FetchResult, Validators } from '../contract';
import { parseItems } from '../parse-utils';
import { ashbyItems, ashbyUrl, parseAshbyJob } from './ashby';
import { bamboohrItems, bamboohrUrl, parseBamboohrJob } from './bamboohr';
import { greenhouseItems, greenhouseUrl, parseGreenhouseJob } from './greenhouse';
import { leverItems, leverUrl, parseLeverJob } from './lever';
import { parsePersonioJob, personioItems, personioUrl } from './personio';
import { parseRecruiteeJob, recruiteeItems, recruiteeUrl } from './recruitee';
import { parseTeamtailorJob, teamtailorItems, teamtailorUrl } from './teamtailor';
import { parseWorkableJob, workableItems, workableUrl } from './workable';

export interface BoardRef {
  ats: AtsProvider;
  token: string;
  company?: string | undefined;
  /** Provider-specific host variant: Lever EU ('eu') or Personio .com ('com'). */
  region?: 'eu' | 'com' | undefined;
}

interface Provider {
  format: 'json' | 'xml';
  url(board: BoardRef): string;
  /** Receives parsed JSON, or the raw text for XML providers. */
  items(body: unknown): unknown[] | undefined;
  parse(item: unknown, board: BoardRef): ExternalJob | undefined;
}

const PROVIDERS: Record<AtsProvider, Provider> = {
  greenhouse: { format: 'json', url: greenhouseUrl, items: greenhouseItems, parse: parseGreenhouseJob },
  lever: { format: 'json', url: leverUrl, items: leverItems, parse: parseLeverJob },
  ashby: { format: 'json', url: ashbyUrl, items: ashbyItems, parse: parseAshbyJob },
  workable: { format: 'json', url: workableUrl, items: workableItems, parse: parseWorkableJob },
  recruitee: { format: 'json', url: recruiteeUrl, items: recruiteeItems, parse: parseRecruiteeJob },
  teamtailor: { format: 'xml', url: teamtailorUrl, items: teamtailorItems, parse: parseTeamtailorJob },
  personio: { format: 'xml', url: personioUrl, items: personioItems, parse: parsePersonioJob },
  bamboohr: { format: 'json', url: bamboohrUrl, items: bamboohrItems, parse: parseBamboohrJob },
};

/** Host of the board's feed: the domain gate key and the allowlist entry it must match. */
export function boardApiHost(board: BoardRef): string {
  return new URL(PROVIDERS[board.ats].url(board)).hostname;
}

/** §4.1 step 6: fetch only the provider's published job-postings endpoint. */
export async function fetchBoard(fetcher: Fetcher, board: BoardRef, validators: Validators): Promise<FetchResult> {
  const provider = PROVIDERS[board.ats];
  const result = await fetcher.fetch(
    {
      url: provider.url(board),
      allowedHosts: sources['company-boards'].allowedHosts,
      expect: provider.format,
      validators,
      // Large boards without pagination (GitLab ≈1.3 MB, Ashby ≈1.8 MB, Workable ≈1.7 MB).
      maxBytes: 16 * 1024 * 1024,
    },
    async (res) => {
      const text = await res.text();
      return { body: provider.format === 'json' ? (JSON.parse(text) as unknown) : text, validators: validatorsFrom(res.headers) };
    },
  );
  if (result.kind === 'not-modified') return { kind: 'unchanged', validators };
  const items = provider.items(result.value.body);
  if (!items) throw new Error(`${board.ats} board ${board.token}: unexpected response shape`);
  const parsed = parseItems(items, (item) => provider.parse(item, board));
  return { kind: 'ok', jobs: parsed.jobs, validators: result.value.validators, malformed: parsed.malformed, seen: items.length };
}
