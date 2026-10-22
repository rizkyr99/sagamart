import {
  CreateTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { CatalogConfig } from './config.js';
import { CATALOG_CONFIG, DYNAMODB } from './tokens.js';

export function createDynamoClient(config: CatalogConfig): DynamoDBClient {
  return new DynamoDBClient({
    region: config.dynamo.region,
    maxAttempts: 3, // RFC-0005 §4.5: 500 ms per call, two retries
    requestHandler: { connectionTimeout: 500, requestTimeout: 500 },
    ...(config.dynamo.endpoint
      ? { endpoint: config.dynamo.endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {}),
  });
}

/**
 * Creates the carts table (one item per cart, ADR-0009) with TTL on `ttl` when configured to: local and test only.
 * Real environments create it with infrastructure code.
 */
export async function ensureCartsTable(client: DynamoDBClient, table: string): Promise<void> {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: table,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ResourceInUseException') throw err;
  }
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: table });
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: table,
        TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
      }),
    );
  } catch (err) {
    // Enabling TTL twice is refused; that just means it is already on.
    if (!/already enabled/i.test((err as Error).message)) throw err;
  }
}

@Injectable()
export class DynamoLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('DynamoLifecycle');

  constructor(
    @Inject(DYNAMODB) private readonly client: DynamoDBClient,
    @Inject(CATALOG_CONFIG) private readonly config: CatalogConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.dynamo.createTable) return;
    await ensureCartsTable(this.client, this.config.dynamo.cartsTable);
    this.log.log({ table: this.config.dynamo.cartsTable }, 'carts table ready');
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
