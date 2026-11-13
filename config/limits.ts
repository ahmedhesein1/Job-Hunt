/**
 * Every tunable number in one place. Source-specific policy (cadence, attribution,
 * allowed hosts) lives in config/sources.ts; these are cross-cutting limits.
 */
export const limits = {
  http: {
    /** §5.2: 15–20 s timeout */
    timeoutMs: 18_000,
    /** Default response-size cap for JSON APIs. */
    maxJsonBytes: 8 * 1024 * 1024,
    /** Cap for streamed XML feeds (each item is parsed incrementally). */
    maxStreamBytes: 40 * 1024 * 1024,
    maxRedirects: 3,
    /** §5.5: retry idempotent GET up to 3 times on 5xx/network errors. */
    maxTransientRetries: 3,
    /** §5.5: ~1 s, 2 s, 4 s plus jitter, strictly bounded. */
    backoffBaseMs: 1_000,
    backoffMaxMs: 8_000,
    /** Never honour a Retry-After longer than this without pausing for review. */
    maxRetryAfterMs: 24 * 60 * 60 * 1000,
  },
  domainGate: {
    /** §5.4: internal starting setting, not a claimed provider limit. */
    defaultMinGapMs: 1_500,
    leaseMs: 90_000,
    /** Max time a run waits for its *own* host spacing before deferring. */
    maxInlineWaitMs: 3_000,
  },
  breaker: {
    transientFailuresToOpen: 3,
    firstPauseMs: 60 * 60 * 1000,
    maxPauseMs: 24 * 60 * 60 * 1000,
    /** 429 cooldown when Retry-After is absent: 15 min, doubling. */
    rateLimitBaseCooldownMs: 15 * 60 * 1000,
    /** After this many consecutive 429s, reduce polling frequency and alert once. */
    rateLimitsBeforeSlowdown: 3,
    maxIntervalMultiplier: 8,
  },
  sync: {
    leaseMs: 5 * 60 * 1000,
    /** §8 step 8: reprocess the last 48 h to catch late edits/reordering. */
    watermarkOverlapMs: 48 * 60 * 60 * 1000,
    /** §8 bootstrap backfill window. */
    bootstrapBackfillDays: 7,
    /** §8 step 7: abort the run if more than this share of items is malformed. */
    maxMalformedRatio: 0.5,
    /** Stop starting new work when the Lambda has less than this left. */
    minRemainingMs: 30_000,
  },
  boards: {
    /**
     * The dispatcher runs every minute (owner decision 2026-11-11, replacing §4.2's
     * 5-minute tick and 60/30-minute cadence). One conditional request per board per
     * interval; unchanged boards answer 304 or a small JSON. No provider publishes a limit.
     */
    batchSize: 15,
    /** Watchlist boards with priority 'normal'. */
    defaultIntervalMinutes: 15,
    /** Watchlist boards with priority 'high' (Egypt-based employers). */
    highPriorityIntervalMinutes: 5,
    /** Stop starting new board checks with this much of the 60 s budget left (no overlap). */
    minRemainingMs: 12_000,
    /** §4.1: newly discovered companies enter a low-frequency queue. */
    discoveredIntervalMinutes: 180,
    maxIntervalMinutes: 24 * 60,
    maxActiveBoards: 150,
    /** Age out boards that keep returning nothing useful. */
    emptyChecksBeforeSlowdown: 14,
    /** 404 must persist this long before the board is retired. */
    notFoundRetireAfterMs: 3 * 24 * 60 * 60 * 1000,
  },
  notifications: {
    /** §10.1 step 6 / §10.4: ≥1.1 s between messages to the private chat. */
    telegramGapMs: 1_100,
    instantMinScore: 80,
    digestMinScore: 60,
    minConfidence: 0.5,
    defaultInstantDailyCap: 30,
    staleAfterPublishMs: 72 * 60 * 60 * 1000,
    quietHours: { startHour: 0, endHour: 8 },
    digestMaxJobs: 20,
    digestJobsPerMessage: 5,
    reconcileMinAgeMs: 2 * 60 * 1000,
    reconcileMaxItems: 50,
    outboxPendingAlertCount: 10,
    outboxPendingAlertAgeMs: 30 * 60 * 1000,
  },
  ttlDays: {
    job: 60,
    dedupe: 60,
    notification: 30,
    sourceRun: 30,
    telegramUpdate: 2,
    jobEvent: 60,
  },
  linkedinSearch: {
    /** One cycle every 3 minutes; each runs the searches that are due (searchIntervalMinutes). */
    cycleMinutes: 3,
    /**
     * Run interval per search by its date-posted window: past-hour searches every cycle,
     * 24 h ones every 15 min, week ones hourly. With pagination (scrapeMaxPagesPerSearch)
     * nothing is missed between runs. ~140 search requests/hour for the 37 searches.
     * Measured 2026-11-13: all searches every 3 minutes (~12 requests/min) drew HTTP 429
     * after 2–3 cycles and ~15-minute cooldowns.
     */
    searchIntervalMinutes: { 'past-hour': 3, 'past-24h': 15, 'past-week': 60, 'past-month': 120, any: 120 },
    /** A search counts as due this long before its interval ends (cycle start jitter). */
    dueSlackMs: 60_000,
    /** Most searches started per cycle (the most overdue first); the rest wait a cycle. */
    maxSearchesPerCycle: 10,
    /** Cycle-wide cap on searches in flight (the scraper allows one at a time). */
    concurrency: 4,
    /**
     * No search starts or continues after this, 35 s into the 60 s invocation; the job
     * detail requests run until detailDeadlineMs, then the pipeline stores the results.
     */
    deadlineMs: 35_000,
    /** Job detail requests (descriptions) stop this long into the invocation. */
    detailDeadlineMs: 45_000,
    /** Most job detail requests per cycle, newest jobs first; the rest keep card data. */
    detailFetchesPerCycle: 8,
    /**
     * Whole-search retries by the cycle. 0: the scraper's HTTP retries
     * (scrapeTransientRetries) are the only retry layer, so a failing search costs at most
     * 1 + scrapeTransientRetries requests per page.
     */
    maxRetries: 0,
    backoffBaseMs: 1_000,
    /**
     * Results pages read per search: further pages only while every card on a page is new
     * (results are newest first). Requests to linkedin.com go one at a time through the
     * domain gate (domainGate.defaultMinGapMs apart).
     */
    scrapeMaxPagesPerSearch: 3,
    /** In-request retries of a 5xx/network failure (backoff ~1–2 s); the only retry layer. */
    scrapeTransientRetries: 1,
    /** Response cap for one guest results or job page (normally well under 200 KB). */
    scrapeMaxPageBytes: 2 * 1024 * 1024,
    /** Unreadable cards above this share of a cycle's cards (min. 10 cards) pause the source. */
    maxMalformedRatio: 0.5,
  },
  linkedinSnapshot: {
    /** Telegram lets bots download files up to 20 MB; saved result pages are far smaller. */
    maxFileBytes: 15 * 1024 * 1024,
    maxCards: 300,
    /** Cards posted earlier than this are ignored. */
    maxAgeDays: 14,
  },
  search: {
    windowDays: 30,
    maxItemsScanned: 300,
    maxResults: 10,
  },
  top: {
    windowDays: 14,
    maxItemsScanned: 200,
    count: 10,
  },
  health: {
    /** Warn after this many consecutive successful zero-match checks. */
    zeroMatchWarnAfter: 2,
  },
} as const;
