import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { NativeAttributeValue } from '@aws-sdk/util-dynamodb';
import { limits } from '../../config/limits';
import type { SourceId } from '../../config/sources';
import type { NormalizedJob } from '../core/normalize';
import type { NormalizedSalary } from '../core/salary';
import { stableId } from '../core/url';
import { ttlAfterDays } from '../lib/time';
import { ddb, isConditionalCheckFailed, isTransactionCanceled, tableName } from './client';
import { gsi1, gsi2, jobIdFromPk, keys, type UserStatus } from './keys';

export type Delivery = 'INSTANT' | 'DIGEST' | 'NONE';

/** Persisted job (§7 Job item). Never includes the full description. */
export interface JobItem {
  jobId: string;
  sourceId: SourceId;
  sourceJobId: string;
  sources: Set<string>;
  title: string;
  company: string;
  companyKey: string;
  location?: string | undefined;
  remoteScope: string;
  eligibility: string;
  eligibleRegions: string[];
  skills: string[];
  seniority?: string | undefined;
  minYears?: number | undefined;
  salary?: NormalizedSalary | undefined;
  applyUrl: string;
  sourceUrl: string;
  canonicalUrl?: string | undefined;
  publishedAt?: string | undefined;
  publishedAtReliable: boolean;
  discoveredAt: string;
  /** Employer requisition ID: the strongest second signal for fingerprint dedupe (§9). */
  requisitionId?: string | undefined;
  score: number;
  confidence: number;
  matchedProfiles: string[];
  clusterId: string;
  duplicateConfidence?: 'HIGH' | 'MEDIUM' | undefined;
  userStatus: UserStatus;
  summary?: string | undefined;
  via?: string | undefined;
  delivery: Delivery;
  matchedSearches?: string[] | undefined;
  employmentType?: string | undefined;
  experienceLevel?: string | undefined;
  dismissReason?: string | undefined;
  alsoOn?: Array<{ sourceId: string; url: string }> | undefined;
  telegramMessageId?: number | undefined;
  digestSentAt?: string | undefined;
}

/** Statuses kept beyond the normal job TTL (§7.3). */
const KEPT_STATUSES: UserStatus[] = ['Saved', 'Applied', 'Interview', 'Offer'];

export function buildJobItem(
  job: NormalizedJob,
  match: { score: number; confidence: number; matchedProfiles: string[] },
  delivery: Delivery,
  clusterId: string,
  nowMs: number,
): Record<string, NativeAttributeValue> {
  const item: JobItem = {
    jobId: job.jobId,
    sourceId: job.sourceId,
    sourceJobId: job.sourceJobId,
    sources: new Set([job.sourceId]),
    title: job.title,
    company: job.company,
    companyKey: job.companyKey,
    location: job.location,
    remoteScope: job.remoteScope,
    eligibility: job.eligibility,
    eligibleRegions: job.eligibleRegions,
    skills: job.skills,
    seniority: job.seniority,
    minYears: job.minYears,
    salary: job.salary,
    applyUrl: job.applyUrl,
    sourceUrl: job.sourceUrl,
    canonicalUrl: job.canonicalUrl,
    publishedAt: job.publishedAt,
    publishedAtReliable: job.publishedAtReliable,
    discoveredAt: job.discoveredAt,
    requisitionId: job.requisitionId,
    score: match.score,
    confidence: match.confidence,
    matchedProfiles: match.matchedProfiles,
    clusterId,
    userStatus: 'New',
    summary: job.summary,
    via: job.via,
    delivery,
    matchedSearches: job.matchedSearches,
    employmentType: job.employmentType,
    experienceLevel: job.experienceLevel,
  };
  return {
    ...keys.job(job.jobId),
    ...gsi1.forJob('New', job.discoveredAt, job.jobId),
    ...(delivery === 'DIGEST' ? gsi2.digest(match.score, job.discoveredAt) : {}),
    entity: 'JOB',
    ...item,
    ttl: ttlAfterDays(nowMs, limits.ttlDays.job),
  };
}

export interface DedupeRecord {
  clusterId: string;
  firstJobId: string;
}

export async function lookupDedupe(urlHash: string | undefined, fpHash: string): Promise<{ url?: DedupeRecord; fp?: DedupeRecord }> {
  const requestKeys = [...(urlHash ? [keys.dedupeUrl(urlHash)] : []), keys.dedupeFingerprint(fpHash)];
  const result = await ddb().send(new BatchGetCommand({ RequestItems: { [tableName()]: { Keys: requestKeys, ConsistentRead: true } } }));
  const items = result.Responses?.[tableName()] ?? [];
  const find = (pk: string) => {
    const i = items.find((x) => x.PK === pk);
    return i ? { clusterId: String(i.clusterId), firstJobId: String(i.firstJobId) } : undefined;
  };
  const out: { url?: DedupeRecord; fp?: DedupeRecord } = {};
  const url = urlHash ? find(keys.dedupeUrl(urlHash).PK) : undefined;
  const fp = find(keys.dedupeFingerprint(fpHash).PK);
  if (url) out.url = url;
  if (fp) out.fp = fp;
  return out;
}

export type InsertResult = 'created' | 'exists' | 'dedupe-race' | 'cap-reached';

export interface InsertJobInput {
  jobItem: Record<string, NativeAttributeValue>;
  jobId: string;
  clusterId: string;
  urlHash?: string | undefined;
  fpHash?: string | undefined;
  notificationPut?: { TableName: string; Item: Record<string, NativeAttributeValue>; ConditionExpression: string } | undefined;
  capUpdate?: { Update: Record<string, unknown> } | undefined;
  nowMs: number;
}

/**
 * §8 step 13: Job + dedupe keys + outbox (+ daily-cap reservation) in one conditional
 * transaction. Replaying the same source page cannot create duplicates.
 */
export async function insertJob(input: InsertJobInput): Promise<InsertResult> {
  const dedupeItem = (key: { PK: string; SK: string }) => ({
    Put: {
      TableName: tableName(),
      Item: { ...key, entity: 'DEDUP', clusterId: input.clusterId, firstJobId: input.jobId, ttl: ttlAfterDays(input.nowMs, limits.ttlDays.dedupe) },
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  });
  const items: Array<{ kind: 'job' | 'dedupe' | 'notif' | 'cap'; item: Record<string, unknown> }> = [
    { kind: 'job', item: { Put: { TableName: tableName(), Item: input.jobItem, ConditionExpression: 'attribute_not_exists(PK)' } } },
  ];
  if (input.urlHash) items.push({ kind: 'dedupe', item: dedupeItem(keys.dedupeUrl(input.urlHash)) });
  if (input.fpHash) items.push({ kind: 'dedupe', item: dedupeItem(keys.dedupeFingerprint(input.fpHash)) });
  if (input.notificationPut) items.push({ kind: 'notif', item: { Put: input.notificationPut } });
  if (input.capUpdate) items.push({ kind: 'cap', item: input.capUpdate });

  try {
    await ddb().send(new TransactWriteCommand({ TransactItems: items.map((i) => i.item) as never }));
    return 'created';
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    const reasons = err.CancellationReasons ?? [];
    const failed = (kind: string) => items.some((i, idx) => i.kind === kind && reasons[idx]?.Code === 'ConditionalCheckFailed');
    if (failed('job')) return 'exists';
    if (failed('dedupe')) return 'dedupe-race';
    if (failed('cap')) return 'cap-reached';
    throw err;
  }
}

/** §8 step 12: record that a duplicate was also seen on another source (once per source). */
export async function attachDuplicate(existingJobId: string, sourceId: string, url: string): Promise<boolean> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: keys.job(existingJobId),
        UpdateExpression: 'ADD sources :src SET alsoOn = list_append(if_not_exists(alsoOn, :empty), :entry)',
        ConditionExpression: 'attribute_exists(PK) AND NOT contains(sources, :srcName)',
        ExpressionAttributeValues: {
          ':src': new Set([sourceId]),
          ':srcName': sourceId,
          ':empty': [],
          ':entry': [{ sourceId, url }],
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

export async function getJob(jobId: string): Promise<JobItem | undefined> {
  const result = await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.job(jobId), ConsistentRead: true }));
  return result.Item as JobItem | undefined;
}

export async function batchGetJobs(jobIds: string[]): Promise<JobItem[]> {
  const out: JobItem[] = [];
  for (let i = 0; i < jobIds.length; i += 100) {
    let request: Record<string, { Keys: Array<Record<string, unknown>> }> | undefined = {
      [tableName()]: { Keys: jobIds.slice(i, i + 100).map((id) => keys.job(id)) },
    };
    // Bounded retries for unprocessed keys (throttling) — never an unbounded loop.
    for (let attempt = 0; request && attempt < 5; attempt++) {
      const result: BatchGetCommandOutput = await ddb().send(new BatchGetCommand({ RequestItems: request }));
      out.push(...((result.Responses?.[tableName()] ?? []) as JobItem[]));
      const unprocessed: Array<Record<string, unknown>> | undefined = result.UnprocessedKeys?.[tableName()]?.Keys;
      request = unprocessed?.length ? { [tableName()]: { Keys: unprocessed } } : undefined;
    }
  }
  return out;
}

/** Allowed transitions: New → Saved → Applied → Interview → Offer; Dismissed from any active status. */
export const ALLOWED_FROM: Record<UserStatus, UserStatus[]> = {
  New: [],
  Saved: ['New'],
  Applied: ['New', 'Saved'],
  Interview: ['Applied'],
  Offer: ['Interview'],
  Dismissed: ['New', 'Saved', 'Applied', 'Interview'],
};

export type TransitionResult = { ok: true; job: JobItem } | { ok: false; reason: 'not-found' | 'invalid-transition'; current?: UserStatus };

export async function transitionStatus(jobId: string, to: UserStatus, nowMs: number, reason?: string): Promise<TransitionResult> {
  const job = await getJob(jobId);
  if (!job) return { ok: false, reason: 'not-found' };
  const from = ALLOWED_FROM[to];
  if (!from.includes(job.userStatus)) return { ok: false, reason: 'invalid-transition', current: job.userStatus };
  const atIso = new Date(nowMs).toISOString();
  const values: Record<string, unknown> = {
    ':to': to,
    ':gpk': gsi1.pk(to),
    ':at': atIso,
  };
  const fromPlaceholders = from.map((s, i) => {
    values[`:f${i}`] = s;
    return `:f${i}`;
  });
  const sets = ['userStatus = :to', 'GSI1PK = :gpk', 'statusChangedAt = :at'];
  const removes = ['GSI2PK', 'GSI2SK'];
  if (KEPT_STATUSES.includes(to)) removes.push('#ttl');
  else {
    sets.push('#ttl = :ttl');
    values[':ttl'] = ttlAfterDays(nowMs, limits.ttlDays.job);
  }
  if (reason) {
    sets.push('dismissReason = :reason');
    values[':reason'] = reason;
  }
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName(),
              Key: keys.job(jobId),
              UpdateExpression: `SET ${sets.join(', ')} REMOVE ${removes.join(', ')}`,
              ConditionExpression: `userStatus IN (${fromPlaceholders.join(', ')})`,
              ExpressionAttributeNames: { '#ttl': 'ttl' },
              ExpressionAttributeValues: values,
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: {
                ...keys.jobEvent(jobId, atIso, stableId(jobId, atIso, to)),
                entity: 'JOB_EVENT',
                type: to.toUpperCase(),
                from: job.userStatus,
                reason,
                createdAt: atIso,
                ...(to === 'Dismissed' ? { ttl: ttlAfterDays(nowMs, limits.ttlDays.jobEvent) } : {}),
              },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (isTransactionCanceled(err)) return { ok: false, reason: 'invalid-transition', current: job.userStatus };
    throw err;
  }
  return { ok: true, job: { ...job, userStatus: to, dismissReason: reason ?? job.dismissReason } };
}

/** Bounded GSI1 query: newest first, discovered on/after `sinceIso`. */
export async function queryByStatus(status: UserStatus, sinceIso: string, maxItems: number): Promise<JobItem[]> {
  const out: JobItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: gsi1.name,
        KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK >= :since',
        ExpressionAttributeValues: { ':pk': gsi1.pk(status), ':since': sinceIso },
        ScanIndexForward: false,
        Limit: Math.min(100, maxItems - out.length),
        ExclusiveStartKey: startKey,
      }),
    );
    out.push(...((result.Items ?? []) as JobItem[]));
    startKey = result.LastEvaluatedKey;
  } while (startKey && out.length < maxItems);
  return out;
}

/** Digest queue (GSI2 `DIGEST`), best score first. Returns job IDs. */
export async function queryDigest(limit: number): Promise<string[]> {
  const result = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: gsi2.name,
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': gsi2.DIGEST },
      Limit: limit,
    }),
  );
  return (result.Items ?? []).map((i) => jobIdFromPk(String(i.PK)));
}

/** Transaction item removing a job from the digest queue and marking it sent (§10.5). */
export function digestSentUpdate(jobId: string, nowMs: number) {
  return {
    Update: {
      TableName: tableName(),
      Key: keys.job(jobId),
      UpdateExpression: 'SET digestSentAt = :at REMOVE GSI2PK, GSI2SK',
      ConditionExpression: 'GSI2PK = :digest',
      ExpressionAttributeValues: { ':at': new Date(nowMs).toISOString(), ':digest': gsi2.DIGEST },
    },
  };
}

export async function setJobNotified(jobId: string, telegramMessageId: number, nowMs: number): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.job(jobId),
      UpdateExpression: 'SET telegramMessageId = :m, notifiedAt = :at',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':m': telegramMessageId, ':at': new Date(nowMs).toISOString() },
    }),
  ).catch((err: unknown) => {
    if (!isConditionalCheckFailed(err)) throw err;
  });
}
