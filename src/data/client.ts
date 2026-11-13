import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * One document client per execution environment (§18.7). The SDK's standard retry mode
 * provides bounded exponential backoff with jitter for throttling (§7.3); we never rely
 * on auto scaling.
 */
function createClient(): DynamoDBDocumentClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const base = new DynamoDBClient({
    maxAttempts: 4,
    retryMode: 'standard',
    ...(endpoint ? { endpoint, region: process.env.AWS_REGION ?? 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
  return DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
    unmarshallOptions: { wrapNumbers: false },
  });
}

let client: DynamoDBDocumentClient | undefined;

export function ddb(): DynamoDBDocumentClient {
  client ??= createClient();
  return client;
}

/** Test hook: point the data layer at DynamoDB Local. */
export function setDdbClient(c: DynamoDBDocumentClient): void {
  client = c;
}

export function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) throw new Error('TABLE_NAME is not set');
  return name;
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

export function isTransactionCanceled(err: unknown): err is { name: string; CancellationReasons?: Array<{ Code?: string }> } {
  return (err as { name?: string })?.name === 'TransactionCanceledException';
}
