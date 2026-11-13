import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { setDdbClient } from '../../src/data/client';

/**
 * DynamoDB Local harness (§16). Start it with:
 *   docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2
 * The table mirrors template.yaml (`JobsTable`); test/integration/template-parity.test.ts
 * fails if the two drift apart.
 */
export const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

export const TABLE_SCHEMA = {
  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },
    { AttributeName: 'SK', KeyType: 'RANGE' },
  ],
  AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map((name) => ({ AttributeName: name, AttributeType: 'S' as const })),
  GlobalSecondaryIndexes: [
    {
      IndexName: 'GSI1',
      KeySchema: [
        { AttributeName: 'GSI1PK', KeyType: 'HASH' as const },
        { AttributeName: 'GSI1SK', KeyType: 'RANGE' as const },
      ],
      Projection: {
        ProjectionType: 'INCLUDE' as const,
        NonKeyAttributes: ['jobId', 'sourceId', 'title', 'company', 'companyKey', 'score', 'confidence', 'applyUrl', 'sourceUrl', 'remoteScope', 'skills', 'salary', 'summary', 'publishedAt', 'discoveredAt', 'via', 'userStatus', 'dismissReason'],
      },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    },
    {
      IndexName: 'GSI2',
      KeySchema: [
        { AttributeName: 'GSI2PK', KeyType: 'HASH' as const },
        { AttributeName: 'GSI2SK', KeyType: 'RANGE' as const },
      ],
      Projection: { ProjectionType: 'KEYS_ONLY' as const },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    },
  ],
  ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
  StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' as const },
} as const;

const raw = new DynamoDBClient({ endpoint: ENDPOINT, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });

/** Creates an isolated table per test file and points the data layer at it. */
export async function createTestTable(): Promise<string> {
  const name = `jobfinder-it-${randomUUID().slice(0, 8)}`;
  await raw.send(new CreateTableCommand({ TableName: name, ...TABLE_SCHEMA } as never));
  await waitUntilTableExists({ client: raw, maxWaitTime: 30 }, { TableName: name });
  process.env.TABLE_NAME = name;
  setDdbClient(DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } }));
  return name;
}

export async function dropTestTable(name: string): Promise<void> {
  await raw.send(new DeleteTableCommand({ TableName: name })).catch(() => undefined);
}
