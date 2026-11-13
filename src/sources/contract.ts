import type { SourceId } from '../../config/sources';

/** Salary as published, before normalisation (§6.3). */
export interface RawSalary {
  min?: number | undefined;
  max?: number | undefined;
  currency?: string | undefined;
  period?: 'year' | 'month' | 'week' | 'day' | 'hour' | undefined;
  /** Who published the figure: 'employer' for ATS data, otherwise the source name. */
  origin: string;
}

/** What every source adapter emits. Fields that are not published stay undefined. */
export interface ExternalJob {
  sourceId: SourceId;
  /** Stable ID within the source (guid, id, posting id). */
  sourceJobId: string;
  title: string;
  company: string;
  location?: string | undefined;
  /** Explicit country/region restrictions published by the source. */
  locationRestrictions?: string[] | undefined;
  /** ISO alpha-2 country when the source supplies one. */
  countryCode?: string | undefined;
  remote?: boolean | undefined;
  description?: string | undefined;
  descriptionIsHtml?: boolean | undefined;
  tags?: string[] | undefined;
  seniorityHints?: string[] | undefined;
  /** URL the Apply button opens (must follow the source's attribution rules). */
  applyUrl: string;
  /** Canonical listing URL on the source. */
  sourceUrl: string;
  /** Employer ATS URL when known — used for dedupe and board discovery. */
  employerUrl?: string | undefined;
  publishedAt?: string | undefined;
  /** False when the source's publish date is known to be unreliable (§10.4). */
  publishedAtReliable?: boolean | undefined;
  salary?: RawSalary | undefined;
  requisitionId?: string | undefined;
  /** Numeric UTC offsets the employer accepts (Himalayas timezoneRestrictions). */
  timezoneOffsets?: number[] | undefined;
  /** Optional per-job attribution label override, e.g. board company. */
  via?: string | undefined;
  /** Saved search labels that matched this job during search evaluation. */
  matchedSearches?: string[] | undefined;
  /** Employment type if exposed by source (e.g. full-time, contract). */
  employmentType?: string | undefined;
  /** Explicit experience level if exposed by source. */
  experienceLevel?: string | undefined;
}

/** What an adapter receives for one run. */
export interface AdapterContext {
  fetcher: import('../scraping/fetcher').Fetcher;
  policy: import('../../config/sources').SourcePolicy;
  validators: Validators;
  /** Earliest publish time worth processing (watermark − overlap, or bootstrap window). */
  sinceMs: number;
  /** Adapter-specific state persisted from the previous successful run. */
  cursor: Record<string, string | number>;
  nowMs: number;
  /** Already-fetched page tracking for HTML sources. */
  seen?: import('../data/seen').SeenStore | undefined;
}

export interface SourceAdapter {
  id: import('../../config/sources').SyncableSourceId;
  fetch(ctx: AdapterContext): Promise<FetchResult>;
}

export interface Validators {
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export type FetchResult =
  | { kind: 'unchanged'; validators: Validators }
  | {
      kind: 'ok';
      jobs: ExternalJob[];
      validators: Validators;
      /** Items the adapter could not parse (§8 step 7). */
      malformed: number;
      /** Total raw items seen, for the malformed-ratio threshold. */
      seen: number;
      /** Adapter-specific cursor state to persist (e.g. HN story id). */
      cursor?: Record<string, string | number> | undefined;
      /** Per-site problems that did not fail the whole run (multi-site sources). */
      warnings?: string[] | undefined;
    }
  | { kind: 'skipped'; reason: string };
