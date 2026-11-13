/** One day of measured usage (UTC day). Every number is read, not assumed. */
export interface LambdaUsage {
  name: string;
  arch: 'arm64' | 'x86_64';
  memoryMb: number;
  timeoutSec: number;
  invocations: number;
  errors: number;
  throttles: number;
  durationSumMs: number;
  durationAvgMs: number | undefined;
  p50Ms: number | undefined;
  p95Ms: number | undefined;
  maxMs: number | undefined;
  /** Invocations whose duration reached the timeout (max ≥ timeout − 100 ms). */
  hitTimeout: boolean;
}

export interface QueueUsage {
  name: string;
  fifo: boolean;
  sent: number;
  received: number;
  deleted: number;
  emptyReceives: number;
  maxVisible: number;
  maxAgeSec: number;
}

export interface LogGroupUsage {
  name: string;
  ingestedBytes: number;
  storedBytes: number;
  retentionDays: number | undefined;
}

export interface AppUsage {
  httpRequests: number;
  httpBytes: number;
  httpErrors: number;
  browserPages: number;
  telegramRequests: number;
  telegramSent: number;
  telegramFailed: number;
  telegramRateLimited: number;
  byHost: Record<string, { requests: number; bytes: number }>;
}

export interface DailyUsage {
  day: string;
  collectedAt: string;
  lambda: LambdaUsage[];
  dynamodb: {
    consumedRcu: number;
    consumedWcu: number;
    readThrottles: number;
    writeThrottles: number;
    /** Table + GSIs. */
    provisionedRcu: number;
    provisionedWcu: number;
    storageBytes: number;
  };
  sqs: QueueUsage[];
  scheduler: { attempts: number; targetErrors: number; throttles: number; dropped: number };
  logs: LogGroupUsage[];
  cloudwatch: { alarms: number; dashboards: number; apiRequestsByCollector: number };
  app: AppUsage;
}

/** Billing facts read from AWS (never estimated). */
export interface BillingFacts {
  budget?: { name: string; limitUsd: number; actualUsd: number; forecastUsd: number | undefined } | undefined;
  plan?: { type: string; status: string; creditsUsd: number | undefined; expires: string | undefined } | undefined;
  errors: string[];
}

export interface CostLine {
  service: string;
  item: string;
  /** Monthly quantity and its unit. */
  quantity: number;
  unit: string;
  freeAllowance: number;
  billable: number;
  usd: number;
}

export interface CostEstimate {
  lines: CostLine[];
  subtotalUsd: number;
  marginPct: number;
  totalUsd: number;
}
