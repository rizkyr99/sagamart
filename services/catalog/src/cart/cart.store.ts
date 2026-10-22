import { ConditionalCheckFailedException, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { ProblemError, problem } from '@sagamart/node-common';
import type { CatalogConfig } from '../config.js';
import { CATALOG_CONFIG, DYNAMODB } from '../tokens.js';
import { emptyCart, isExpired } from './cart.js';
import type { CartLine, CartState } from './cart.js';

/** A cart as stored, with the version the next write must match; null when no item exists. */
export interface LoadedCart {
  state: CartState;
  version: number | null;
}

/** Attempts per write when another write to the same cart wins the race (a buyer's tabs, ADR-0009). */
const ATTEMPTS = 6;

const meter = metrics.getMeter('@sagamart/catalog');
const writes = meter.createCounter('sagamart.catalog.cart_writes', {
  description: 'Cart writes, by outcome.',
});
const conflicts = meter.createCounter('sagamart.catalog.cart_version_conflicts', {
  description: 'Cart writes that lost a version race and were retried.',
});

const unavailable = (detail: string): ProblemError =>
  new ProblemError(problem({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', detail }));

// ---- Item mapping: PK CART#<cartKey>, a `lines` map, `version`, `updatedAt`, `ttl` (RFC-0005 §4.3) ----

const pk = (cartKey: string): Record<string, AttributeValue> => ({ pk: { S: `CART#${cartKey}` } });

function toLines(map: Record<string, AttributeValue> | undefined): Record<string, CartLine> {
  return Object.fromEntries(
    Object.entries(map ?? {}).map(([sku, value]) => {
      const line = value.M ?? {};
      return [
        sku,
        {
          quantity: Number(line.quantity?.N),
          priceSnapshot: Number(line.priceSnapshot?.N),
          addedAt: line.addedAt?.S ?? '',
        },
      ];
    }),
  );
}

function toItem(
  cartKey: string,
  state: CartState,
  version: number,
  now: Date,
): Record<string, AttributeValue> {
  return {
    ...pk(cartKey),
    ownerType: { S: cartKey.startsWith('user:') ? 'user' : 'guest' },
    lines: {
      M: Object.fromEntries(
        Object.entries(state.lines).map(([sku, l]) => [
          sku,
          {
            M: {
              quantity: { N: String(l.quantity) },
              priceSnapshot: { N: String(l.priceSnapshot) },
              addedAt: { S: l.addedAt },
            },
          },
        ]),
      ),
    },
    version: { N: String(version) },
    updatedAt: { S: now.toISOString() },
    ttl: { N: String(state.ttl) },
  };
}

/** Carts in DynamoDB, one item each (ADR-0009). Every write is one PutItem conditional on the version it read. */
@Injectable()
export class CartStore {
  private readonly log = new Logger('CartStore');
  private readonly table: string;

  constructor(
    @Inject(DYNAMODB) private readonly client: DynamoDBClient,
    @Inject(CATALOG_CONFIG) config: CatalogConfig,
  ) {
    this.table = config.dynamo.cartsTable;
  }

  /** The cart, or an empty one if it never existed. An expired cart reads as empty but keeps its version. */
  async load(cartKey: string, now: Date): Promise<LoadedCart> {
    const out = await this.call(() =>
      this.client.send(new GetItemCommand({ TableName: this.table, Key: pk(cartKey), ConsistentRead: true })),
    );
    if (!out.Item) return { state: emptyCart(), version: null };
    const state: CartState = { lines: toLines(out.Item.lines?.M), ttl: Number(out.Item.ttl?.N) };
    // TTL deletion is lazy: an expired item can linger, and is replaced by the next write.
    return { state: isExpired(state, now) ? emptyCart() : state, version: Number(out.Item.version?.N) };
  }

  /**
   * Reads the cart, applies `change` (the cart rules), and writes the result if nobody wrote in between; otherwise
   * reads again and re-applies. The rules, including the line limit, always see the cart as it really is.
   */
  async update(cartKey: string, change: (cart: CartState, now: Date) => CartState): Promise<CartState> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const now = new Date();
      const { state, version } = await this.load(cartKey, now);
      const next = change(state, now); // may throw a CartRuleError: nothing is written
      try {
        await this.call(() =>
          this.client.send(
            new PutItemCommand({
              TableName: this.table,
              Item: toItem(cartKey, next, (version ?? 0) + 1, now),
              ...(version === null
                ? { ConditionExpression: 'attribute_not_exists(pk)' }
                : {
                    ConditionExpression: '#version = :version',
                    ExpressionAttributeNames: { '#version': 'version' },
                    ExpressionAttributeValues: { ':version': { N: String(version) } },
                  }),
            }),
          ),
        );
        writes.add(1, { outcome: 'written' });
        return next;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        conflicts.add(1);
        // Jittered backoff, so racing tabs don't collide again in lockstep.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
      }
    }
    writes.add(1, { outcome: 'contended' });
    throw unavailable('The cart is changing too fast to update. Retry shortly.');
  }

  /** Runs a DynamoDB call; anything but a lost version race means DynamoDB is unavailable to us (503). */
  private async call<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw err;
      this.log.warn({ err }, 'DynamoDB call failed');
      throw unavailable('Carts are temporarily unavailable.');
    }
  }
}
