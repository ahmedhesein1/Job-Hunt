/**
 * §7 single-table key layout for table `jobfinder`. All key construction goes through
 * this module so the layout is defined in exactly one place.
 */
export type UserStatus = 'New' | 'Saved' | 'Applied' | 'Interview' | 'Offer' | 'Dismissed';
export const USER_STATUSES: UserStatus[] = ['New', 'Saved', 'Applied', 'Interview', 'Offer', 'Dismissed'];

export type Entity =
  | 'JOB'
  | 'JOB_EVENT'
  | 'DEDUP'
  | 'NOTIF'
  | 'SOURCE_STATE'
  | 'SOURCE_RUN'
  | 'DOMAIN'
  | 'BOARD'
  | 'COMPANY'
  | 'SETTINGS'
  | 'LOCK'
  | 'TELEGRAM_RATE'
  | 'TELEGRAM_UPDATE';

// A type alias (not an interface) so keys are assignable to SDK `Record<string, …>` types.
export type Key = {
  PK: string;
  SK: string;
};

export const keys = {
  job: (jobId: string): Key => ({ PK: `JOB#${jobId}`, SK: 'META' }),
  jobEvent: (jobId: string, atIso: string, eventId: string): Key => ({ PK: `JOB#${jobId}`, SK: `EVENT#${atIso}#${eventId}` }),
  dedupeUrl: (hash: string): Key => ({ PK: `DEDUP#URL#${hash}`, SK: 'META' }),
  dedupeFingerprint: (hash: string): Key => ({ PK: `DEDUP#FP#${hash}`, SK: 'META' }),
  notification: (notificationId: string): Key => ({ PK: `NOTIF#${notificationId}`, SK: 'META' }),
  sourceState: (sourceId: string): Key => ({ PK: `SOURCE#${sourceId}`, SK: 'STATE' }),
  sourceRun: (sourceId: string, atIso: string, runId: string): Key => ({ PK: `SOURCE#${sourceId}`, SK: `RUN#${atIso}#${runId}` }),
  domainGate: (hostname: string): Key => ({ PK: `DOMAIN#${hostname.toLowerCase()}`, SK: 'GATE' }),
  board: (ats: string, token: string): Key => ({ PK: `BOARD#${ats}#${token.toLowerCase()}`, SK: 'META' }),
  company: (companyKey: string): Key => ({ PK: `COMPANY#${companyKey}`, SK: 'META' }),
  settings: (): Key => ({ PK: 'SETTINGS', SK: 'GLOBAL' }),
  lock: (name: string): Key => ({ PK: `LOCK#${name}`, SK: 'META' }),
  telegramRate: (chatId: string): Key => ({ PK: `TELEGRAM#${chatId}`, SK: 'RATE' }),
  telegramUpdate: (updateId: number): Key => ({ PK: `UPDATE#${updateId}`, SK: 'META' }),
  /** Career-page detail URL already fetched (TTL), so pages are not re-downloaded every run. */
  seenPage: (urlHash: string): Key => ({ PK: `SEEN#${urlHash}`, SK: 'META' }),
  /** In-app usage counters for one UTC day (HTTP, Telegram). */
  appUsage: (day: string): Key => ({ PK: `USAGE#${day}`, SK: 'APP' }),
  /** Collected daily AWS usage + cost summary; one partition, queried by day range. */
  costDay: (day: string): Key => ({ PK: 'COST', SK: `DAY#${day}` }),
};

/** GSI1: user status lists ordered by discovery time (§7.1). */
export const gsi1 = {
  name: 'GSI1',
  forJob: (status: UserStatus, discoveredAt: string, jobId: string) => ({
    GSI1PK: `STATUS#${status}`,
    GSI1SK: `${discoveredAt}#${jobId}`,
  }),
  pk: (status: UserStatus) => `STATUS#${status}`,
};

/** GSI2: sparse queues (§7.1). Remove the attributes when an item leaves the queue. */
export const gsi2 = {
  name: 'GSI2',
  DIGEST: 'DIGEST',
  OUTBOX_PENDING: 'OUTBOX#PENDING',
  BOARDS_DUE: 'BOARDS#DUE',
  /** Best score first when queried ascending. */
  digest: (score: number, discoveredAt: string) => ({
    GSI2PK: 'DIGEST',
    GSI2SK: `S#${String(999 - Math.max(0, Math.min(999, Math.round(score)))).padStart(3, '0')}#${discoveredAt}`,
  }),
  outboxPending: (createdAt: string) => ({ GSI2PK: 'OUTBOX#PENDING', GSI2SK: createdAt }),
  boardDue: (nextCheckAt: string) => ({ GSI2PK: 'BOARDS#DUE', GSI2SK: nextCheckAt }),
};

export function jobIdFromPk(pk: string): string {
  return pk.replace(/^JOB#/, '');
}
