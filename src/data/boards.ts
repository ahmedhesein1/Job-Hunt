import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { limits } from '../../config/limits';
import type { AtsProvider } from '../../config/sources';
import type { BoardRef } from '../sources/ats/common';
import type { Validators } from '../sources/contract';
import { iso, MINUTE_MS } from '../lib/time';
import { ddb, isConditionalCheckFailed, isTransactionCanceled, tableName } from './client';
import { gsi2, keys } from './keys';

/** §7 `BOARD#<ats>#<token>` record. */
export type BoardStatus = 'PENDING_VALIDATION' | 'ACTIVE' | 'UNAVAILABLE' | 'MANUAL_REVIEW' | 'RETIRED';

export interface BoardItem {
  ats: AtsProvider;
  token: string;
  region?: 'eu' | 'com' | undefined;
  hostname: string;
  company?: string | undefined;
  nextCheckAt: string;
  intervalMinutes: number;
  etag?: string | undefined;
  lastModified?: string | undefined;
  enabled: boolean;
  priority: 'high' | 'normal' | 'low';
  addedFrom: string;
  status: BoardStatus;
  bootstrappedAt?: string | undefined;
  consecutiveEmptyChecks: number;
  stableChecks: number;
  notFoundSince?: number | undefined;
  lastCheckAt?: string | undefined;
  lastSuccessAt?: string | undefined;
  leaseUntil?: number | undefined;
  leaseOwner?: string | undefined;
}

export function boardRef(b: Pick<BoardItem, 'ats' | 'token' | 'company' | 'region'>): BoardRef {
  return { ats: b.ats, token: b.token, company: b.company, region: b.region };
}

export interface AddBoardInput {
  ref: BoardRef;
  hostname: string;
  addedFrom: string;
  priority: BoardItem['priority'];
  intervalMinutes: number;
  /** First check time; defaults to now. */
  firstCheckAtMs: number;
}

export type AddBoardResult = 'added' | 'exists' | 'cap-reached';

/**
 * §4.1 step 5: store a CompanyBoard. Atomically increments the active-board counter on
 * SETTINGS under the v1 cap (§4.2 ≈150 boards).
 */
export async function addBoard(input: AddBoardInput): Promise<AddBoardResult> {
  const nextCheckAt = iso(input.firstCheckAtMs);
  const item: BoardItem = {
    ats: input.ref.ats,
    // Keep the provider's exact token (Lever/Ashby names can be case-sensitive); only the
    // DynamoDB key is lowercased (keys.board) so a board cannot be added twice.
    token: input.ref.token,
    region: input.ref.region,
    hostname: input.hostname,
    company: input.ref.company,
    nextCheckAt,
    intervalMinutes: input.intervalMinutes,
    enabled: true,
    priority: input.priority,
    addedFrom: input.addedFrom,
    status: 'PENDING_VALIDATION',
    consecutiveEmptyChecks: 0,
    stableChecks: 0,
  };
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName(),
              Item: { ...keys.board(item.ats, item.token), ...gsi2.boardDue(nextCheckAt), entity: 'BOARD', ...item },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Update: {
              TableName: tableName(),
              Key: keys.settings(),
              UpdateExpression: 'SET activeBoards = if_not_exists(activeBoards, :zero) + :one, entity = :e',
              ConditionExpression: 'attribute_not_exists(activeBoards) OR activeBoards < :cap',
              ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':cap': limits.boards.maxActiveBoards, ':e': 'SETTINGS' },
            },
          },
        ],
      }),
    );
    return 'added';
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    const reasons = err.CancellationReasons ?? [];
    if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'exists';
    if (reasons[1]?.Code === 'ConditionalCheckFailed') return 'cap-reached';
    throw err;
  }
}

export async function getBoard(ats: string, token: string): Promise<BoardItem | undefined> {
  const result = await ddb().send(new GetCommand({ TableName: tableName(), Key: keys.board(ats, token) }));
  return result.Item as BoardItem | undefined;
}

/** §4.2: due boards from the sparse GSI2 `BOARDS#DUE` index, oldest due first. */
export async function queryDueBoards(nowMs: number, limit: number): Promise<BoardItem[]> {
  const result = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: gsi2.name,
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :now',
      ExpressionAttributeValues: { ':pk': gsi2.BOARDS_DUE, ':now': iso(nowMs) },
      Limit: limit,
    }),
  );
  const ids = (result.Items ?? []).map((i) => ({ PK: String(i.PK), SK: String(i.SK) }));
  // GSI reads are eventually consistent; re-read base items before acting (§7.1).
  const boards: BoardItem[] = [];
  for (const key of ids) {
    const item = await ddb().send(new GetCommand({ TableName: tableName(), Key: key, ConsistentRead: true }));
    if (item.Item && item.Item.enabled === true) boards.push(item.Item as BoardItem);
  }
  return boards;
}

/** Per-board lease so overlapping dispatcher runs never check the same board twice. */
export async function leaseBoard(board: BoardItem, owner: string, nowMs: number, leaseMs: number): Promise<boolean> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: keys.board(board.ats, board.token),
        UpdateExpression: 'SET leaseOwner = :o, leaseUntil = :u',
        ConditionExpression: '(attribute_not_exists(leaseUntil) OR leaseUntil < :now) AND nextCheckAt <= :nowIso AND enabled = :true',
        ExpressionAttributeValues: { ':o': owner, ':u': nowMs + leaseMs, ':now': nowMs, ':nowIso': iso(nowMs), ':true': true },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

export interface BoardCheckUpdate {
  status: BoardStatus;
  validators?: Validators | undefined;
  /** Minutes until the next check (already includes backoff/slowdown). */
  nextIntervalMinutes: number;
  intervalMinutes?: number | undefined;
  bootstrappedAt?: string | undefined;
  consecutiveEmptyChecks: number;
  stableChecks: number;
  notFoundSince?: number | null | undefined;
  success: boolean;
  retire?: boolean | undefined;
  company?: string | undefined;
}

/**
 * §4.2: update `nextCheckAt` only after the outcome is recorded. Retired boards leave
 * the due index and release their slot under the active-board cap.
 */
export async function completeBoardCheck(board: BoardItem, owner: string, update: BoardCheckUpdate, nowMs: number): Promise<void> {
  const nextCheckAt = iso(nowMs + update.nextIntervalMinutes * MINUTE_MS);
  const sets = [
    '#status = :status',
    'nextCheckAt = :next',
    'lastCheckAt = :now',
    'consecutiveEmptyChecks = :empty',
    'stableChecks = :stable',
  ];
  const values: Record<string, unknown> = {
    ':status': update.status,
    ':next': nextCheckAt,
    ':now': iso(nowMs),
    ':empty': update.consecutiveEmptyChecks,
    ':stable': update.stableChecks,
    ':owner': owner,
  };
  const removes = ['leaseOwner', 'leaseUntil'];
  if (update.retire) {
    sets.push('enabled = :false');
    values[':false'] = false;
    removes.push('GSI2PK', 'GSI2SK');
  } else {
    sets.push('GSI2PK = :gpk', 'GSI2SK = :next');
    values[':gpk'] = gsi2.BOARDS_DUE;
  }
  if (update.success) sets.push('lastSuccessAt = :now');
  if (update.intervalMinutes !== undefined) {
    sets.push('intervalMinutes = :interval');
    values[':interval'] = update.intervalMinutes;
  }
  if (update.bootstrappedAt) {
    sets.push('bootstrappedAt = if_not_exists(bootstrappedAt, :boot)');
    values[':boot'] = update.bootstrappedAt;
  }
  if (update.company) {
    sets.push('company = if_not_exists(company, :company)');
    values[':company'] = update.company;
  }
  if (update.validators) {
    if (update.validators.etag) {
      sets.push('etag = :etag');
      values[':etag'] = update.validators.etag;
    } else removes.push('etag');
    if (update.validators.lastModified) {
      sets.push('lastModified = :lm');
      values[':lm'] = update.validators.lastModified;
    } else removes.push('lastModified');
  }
  if (update.notFoundSince === null) removes.push('notFoundSince');
  else if (update.notFoundSince !== undefined) {
    sets.push('notFoundSince = if_not_exists(notFoundSince, :nf)');
    values[':nf'] = update.notFoundSince;
  }

  const boardUpdate = {
    Update: {
      TableName: tableName(),
      Key: keys.board(board.ats, board.token),
      UpdateExpression: `SET ${sets.join(', ')} REMOVE ${removes.join(', ')}`,
      ConditionExpression: 'leaseOwner = :owner',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
    },
  };
  try {
    if (update.retire) {
      await ddb().send(
        new TransactWriteCommand({
          TransactItems: [
            boardUpdate,
            {
              Update: {
                TableName: tableName(),
                Key: keys.settings(),
                UpdateExpression: 'SET activeBoards = activeBoards - :one',
                ConditionExpression: 'activeBoards > :zero',
                ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
              },
            },
          ],
        }),
      );
    } else {
      await ddb().send(new UpdateCommand(boardUpdate.Update));
    }
  } catch (err) {
    // Lease lost to another run: that run records its own outcome.
    if (!isConditionalCheckFailed(err) && !isTransactionCanceled(err)) throw err;
  }
}

/** Re-enable a board after manual review. */
export async function resumeBoard(ats: string, token: string, nowMs: number): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.board(ats, token),
      UpdateExpression: 'SET #status = :active, nextCheckAt = :now, GSI2PK = :gpk, GSI2SK = :now REMOVE notFoundSince',
      ConditionExpression: 'attribute_exists(PK) AND enabled = :true',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'ACTIVE', ':now': iso(nowMs), ':gpk': gsi2.BOARDS_DUE, ':true': true },
    }),
  );
}
