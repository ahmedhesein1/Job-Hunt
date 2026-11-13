import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { initialBreaker, type BreakerState } from '../scraping/circuit-breaker';
import type { AcquireResult, DomainGateStore, GateRecord } from '../scraping/domain-gate';
import { ddb, isConditionalCheckFailed, tableName } from './client';
import { keys } from './keys';

type Item = Record<string, unknown>;

function toBreaker(item: Item): BreakerState {
  const base = initialBreaker();
  return {
    status: (item.breakerStatus as BreakerState['status']) ?? base.status,
    consecutive429: Number(item.consecutive429 ?? 0),
    consecutive5xx: Number(item.consecutive5xx ?? 0),
    consecutiveNetworkFailures: Number(item.consecutiveNetworkFailures ?? 0),
    breakerEpisodes: Number(item.breakerEpisodes ?? 0),
    cooldownUntil: item.cooldownUntil === undefined ? undefined : Number(item.cooldownUntil),
    pausedReason: item.pausedReason as string | undefined,
    pausedAt: item.pausedAt === undefined ? undefined : Number(item.pausedAt),
    intervalMultiplier: Number(item.intervalMultiplier ?? 1),
  };
}

export function toGateRecord(hostname: string, item: Item | undefined): GateRecord | undefined {
  if (!item) return undefined;
  return {
    hostname,
    nextAllowedAt: Number(item.nextAllowedAt ?? 0),
    leaseUntil: item.leaseUntil === undefined ? undefined : Number(item.leaseUntil),
    leaseOwner: item.leaseOwner as string | undefined,
    breaker: toBreaker(item),
  };
}

/** DynamoDB implementation of the §5.4 domain gate (`DOMAIN#<hostname>` / `GATE`). */
export class DynamoDomainGateStore implements DomainGateStore {
  async tryAcquire(hostname: string, owner: string, nowMs: number, leaseMs: number): Promise<AcquireResult> {
    try {
      const result = await ddb().send(
        new UpdateCommand({
          TableName: tableName(),
          Key: keys.domainGate(hostname),
          UpdateExpression: 'SET leaseOwner = :owner, leaseUntil = :lease, entity = :entity, hostname = :host',
          ConditionExpression: [
            '(attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
            '(attribute_not_exists(nextAllowedAt) OR nextAllowedAt <= :now)',
            '(attribute_not_exists(cooldownUntil) OR cooldownUntil <= :now)',
            '(attribute_not_exists(breakerStatus) OR breakerStatus <> :manual)',
          ].join(' AND '),
          ExpressionAttributeValues: {
            ':owner': owner,
            ':lease': nowMs + leaseMs,
            ':now': nowMs,
            ':manual': 'MANUAL_REVIEW',
            ':entity': 'DOMAIN',
            ':host': hostname,
          },
          ReturnValues: 'ALL_NEW',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return { ok: true, record: toGateRecord(hostname, result.Attributes) as GateRecord };
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        // The exception carries the old item in raw AttributeValue form.
        const raw = (err as { Item?: Record<string, AttributeValue> }).Item;
        return { ok: false, record: toGateRecord(hostname, raw ? unmarshall(raw) : undefined) };
      }
      throw err;
    }
  }

  async release(hostname: string, owner: string, update: { nextAllowedAt: number; breaker: BreakerState }): Promise<void> {
    const b = update.breaker;
    const set: string[] = [
      'nextAllowedAt = :next',
      'breakerStatus = :status',
      'consecutive429 = :c429',
      'consecutive5xx = :c5xx',
      'consecutiveNetworkFailures = :cnet',
      'breakerEpisodes = :episodes',
      'intervalMultiplier = :mult',
    ];
    const remove: string[] = ['leaseOwner', 'leaseUntil'];
    const values: Item = {
      ':next': update.nextAllowedAt,
      ':status': b.status,
      ':c429': b.consecutive429,
      ':c5xx': b.consecutive5xx,
      ':cnet': b.consecutiveNetworkFailures,
      ':episodes': b.breakerEpisodes,
      ':mult': b.intervalMultiplier,
      ':owner': owner,
    };
    if (b.cooldownUntil !== undefined) {
      set.push('cooldownUntil = :cool');
      values[':cool'] = b.cooldownUntil;
    } else remove.push('cooldownUntil');
    if (b.pausedReason !== undefined) {
      set.push('pausedReason = :reason', 'pausedAt = :pausedAt');
      values[':reason'] = b.pausedReason;
      values[':pausedAt'] = b.pausedAt ?? Date.now();
    } else remove.push('pausedReason', 'pausedAt');
    try {
      await ddb().send(
        new UpdateCommand({
          TableName: tableName(),
          Key: keys.domainGate(hostname),
          UpdateExpression: `SET ${set.join(', ')} REMOVE ${remove.join(', ')}`,
          ConditionExpression: 'leaseOwner = :owner',
          ExpressionAttributeValues: values,
        }),
      );
    } catch (err) {
      // Our lease expired and someone else holds the host now; their release wins.
      if (!isConditionalCheckFailed(err)) throw err;
    }
  }

  async get(hostname: string): Promise<GateRecord | undefined> {
    const result = await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.domainGate(hostname) }));
    return toGateRecord(hostname, result.Item);
  }
}

/** Manual review resume: clears the host breaker (used by /resume). */
export async function resetDomainGate(hostname: string): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.domainGate(hostname),
      UpdateExpression:
        'SET breakerStatus = :closed, consecutive429 = :zero, consecutive5xx = :zero, consecutiveNetworkFailures = :zero, breakerEpisodes = :zero REMOVE cooldownUntil, pausedReason, pausedAt',
      ExpressionAttributeValues: { ':closed': 'CLOSED', ':zero': 0 },
    }),
  );
}
