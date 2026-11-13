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
    /** Owner requirement: every saved search is considered once per 3-minute cycle. */
    cycleMinutes: 3,
    /** Cycle-wide cap on searches in flight (a provider may set a lower one). */
    concurrency: 4,
    /** Stop starting or retrying searches this long into the 60 s invocation. */
    deadlineMs: 45_000,
    maxRetries: 2,
    backoffBaseMs: 1_000,
    /** Re-read overlap: longest collector run (rendered pages, 180 s) plus margin. */
    windowOverlapMs: 4 * 60_000,
    /** First cycle ever: search the last day of stored jobs. */
    firstWindowMs: 24 * 60 * 60_000,
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
