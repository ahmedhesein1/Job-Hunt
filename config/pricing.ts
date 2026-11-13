/**
 * eu-north-1 (Stockholm) on-demand prices used by the cost estimator, and the monthly
 * free allowances that apply to this account.
 *
 * Source: AWS Price List API (`aws pricing get-products`, region code eu-north-1), read on
 * 2026-11-11, except where `source` says otherwise. Prices change: re-check before relying
 * on them. Every figure produced from this file is an ESTIMATE, not the AWS bill; the bill
 * is read from the AWS Budgets actual-spend figure (see src/cost/collect.ts).
 *
 * Free allowances: the account is on the AWS Free plan (GetAccountPlanState, 2026-11-11:
 * FREE / ACTIVE, $140 credits, expires 2027-05-10). Always-free monthly allowances apply
 * per service; they are NOT one shared pool. Credits are not modelled: the estimate shows
 * cost before credits, which is what the "job-hunt" budget (UnblendedCost) measures.
 */
export const PRICING_AS_OF = '2026-11-11';

export const pricing = {
  lambda: {
    /** USD per GB-second, first tier (EUN1-Lambda-GB-Second[-ARM]). */
    gbSecondArm: 0.0000133334,
    gbSecondX86: 0.0000166667,
    /** USD per request (EUN1-Request[-ARM]). */
    request: 0.0000002,
  },
  dynamodb: {
    /** Provisioned capacity, USD per unit-hour (EUN1-[Read|Write]CapacityUnit-Hrs). */
    rcuHour: 0.00014,
    wcuHour: 0.000698,
    /** Standard table storage, USD per GB-month (EUN1-TimedStorage-ByteHrs). */
    storageGbMonth: 0.269,
  },
  sqs: {
    /** USD per request (EUN1-Requests-FIFO-Tier1 / EUN1-Requests-Tier1). */
    fifoRequest: 0.0000005,
    standardRequest: 0.0000004,
  },
  cloudwatch: {
    /** Standard-class log ingestion, USD per GB (EUN1-DataProcessing-Bytes). */
    logIngestGb: 0.54,
    /** Log storage, USD per GB-month (EUN1-TimedStorage-ByteHrs). */
    logStorageGbMonth: 0.028,
    /** GetMetricStatistics and other standard API calls, USD per request (EUN1-CW:Requests). */
    apiRequest: 0.00001,
    /** Standard alarm, USD per alarm-month (EUN1-CW:AlarmMonitorUsage). */
    alarmMonth: 0.1,
    /** Dashboard beyond the free ones, USD per month. Source: aws.amazon.com/cloudwatch/pricing. */
    dashboardMonth: 3,
  },
  scheduler: {
    /** USD per invocation after the free allowance. Source: aws.amazon.com/eventbridge/pricing. */
    invocation: 0.000001,
  },
  dataTransfer: {
    /** Internet egress, USD per GB, first 10 TB. Inbound is free. Source: aws.amazon.com/ec2/pricing/on-demand. */
    outGb: 0.09,
  },
} as const;

/** Always-free monthly allowances, per service. */
export const freeTier = {
  lambdaRequests: 1_000_000,
  lambdaGbSeconds: 400_000,
  dynamodbRcu: 25,
  dynamodbWcu: 25,
  dynamodbStorageGb: 25,
  /** Standard + FIFO requests combined. */
  sqsRequests: 1_000_000,
  /** Ingestion + storage + scanned data, combined. */
  cloudwatchLogsGb: 5,
  cloudwatchApiRequests: 1_000_000,
  cloudwatchAlarms: 10,
  /** Dashboards with up to 50 metrics each. */
  cloudwatchDashboards: 3,
  schedulerInvocations: 14_000_000,
  dataTransferOutGb: 100,
} as const;

export const costSettings = {
  /** Name of the existing AWS budget to monitor (never created or modified here). */
  budgetName: 'job-hunt',
  /** Added on top of every estimate to absorb rounding and unmeasured items. */
  safetyMarginPct: 20,
  /** Warn when the projected or actual monthly cost reaches this share of the budget. */
  warnAtBudgetPct: 80,
  /** Days of history used for projections. */
  projectionWindowDays: 7,
  /** Hours in an average month (365 × 24 / 12). */
  hoursPerMonth: 730,
  daysPerMonth: 30,
} as const;
