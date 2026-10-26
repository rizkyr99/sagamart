import { createClient } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { IDENTITY_HEADER } from '@sagamart/node-common';
import { InventoryService } from '@sagamart/contracts/inventory/v1';
import type { GatewayConfig } from './config.js';
import type { Deadline } from './deadline.js';
import type { Caller } from './dev-auth.js';
import { InternalClient } from './internal-client.js';
import { lookupStock } from './stock.js';
import { GATEWAY_CONFIG } from './tokens.js';

const unknownStock = metrics.getMeter('@sagamart/gateway').createCounter('sagamart.gateway.stock_unknown', {
  description: 'SKUs shown as UNKNOWN because Inventory failed or missed its deadline.',
});

/**
 * Inventory over gRPC (contracts/proto). Each call carries `x-sagamart-identity` for `inventory` and the caller's
 * deadline as the gRPC deadline, which Inventory's Go handlers see on their context.
 */
@Injectable()
export class InventoryClient implements OnApplicationBootstrap {
  private readonly log = new Logger('InventoryClient');
  private readonly client: Client<typeof InventoryService>;
  private readonly stockDeadlineMs: number;

  constructor(
    @Inject(GATEWAY_CONFIG) config: GatewayConfig,
    private readonly internal: InternalClient,
  ) {
    this.stockDeadlineMs = config.stockDeadlineMs;
    this.client = createClient(
      InventoryService,
      createGrpcTransport({
        baseUrl: config.inventoryUrl,
        // Keep the HTTP/2 connection open between requests: setting one up can take most of the 150 ms budget.
        pingIntervalMs: 30_000,
        pingIdleConnection: true,
      }),
    );
  }

  /** Opens the connection before the first page needs it. Best effort: never delays startup past 1 s or fails it. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      // One placeholder SKU: an empty list is invalid, and an unknown SKU is simply left out of the answer.
      await this.client.getStockLevels(
        { skus: ['WARM-UP'] },
        {
          headers: { [IDENTITY_HEADER]: this.internal.identityFor({ roles: [] }, 'inventory') },
          timeoutMs: 1000,
        },
      );
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'inventory not reachable at startup',
      );
    }
  }

  /** Sets a SKU's on-hand stock as the caller, who must be an admin (#17). Throws Inventory's ConnectError. */
  async setStockLevel(
    req: { sku: string; onHand: number; expectedVersion: number },
    caller: Caller,
    deadline: Deadline,
  ): Promise<{ sku: string; onHand: number; reserved: number; available: number; version: number }> {
    const { level } = await this.client.setStockLevel(
      { sku: req.sku, onHand: BigInt(req.onHand), expectedVersion: BigInt(req.expectedVersion) },
      this.options(caller, deadline),
    );
    if (!level) throw new Error('SetStockLevel answered without a level');
    return {
      sku: level.sku,
      onHand: Number(level.onHand),
      reserved: Number(level.reserved),
      available: Number(level.available),
      version: Number(level.version),
    };
  }

  /** One SKU's full level, or null if Inventory has no record of it. Throws on failure. */
  async level(
    sku: string,
    caller: Caller,
    deadline: Deadline,
  ): Promise<{ version: number; onHand: number; reserved: number } | null> {
    const { levels } = await this.client.getStockLevels({ skus: [sku] }, this.options(caller, deadline));
    const level = levels.find((l) => l.sku === sku);
    return level
      ? { version: Number(level.version), onHand: Number(level.onHand), reserved: Number(level.reserved) }
      : null;
  }

  private options(caller: Caller, deadline: Deadline) {
    return {
      headers: { [IDENTITY_HEADER]: this.internal.identityFor(caller, 'inventory') },
      timeoutMs: Math.max(1, deadline.remaining()),
      signal: deadline.signal(),
    };
  }

  /**
   * Available units per SKU for display; null for UNKNOWN. Never throws: browsing renders without stock
   * (RFC-0005 §4.4). All batches share one deadline: the request's, capped at GATEWAY_STOCK_DEADLINE_MS (150 ms).
   */
  async availability(
    skus: readonly string[],
    caller: Caller,
    requestDeadline: Deadline,
  ): Promise<Map<string, number | null>> {
    // Stock is optional on a page: wait at most GATEWAY_STOCK_DEADLINE_MS, and never past the request's own budget.
    const deadline = requestDeadline.cap(this.stockDeadlineMs);
    const identity = this.internal.identityFor(caller, 'inventory');
    return lookupStock(
      skus,
      async (batch) => {
        const response = await this.client.getStockLevels(
          { skus: batch },
          {
            headers: { [IDENTITY_HEADER]: identity },
            timeoutMs: Math.max(1, deadline.remaining()),
            signal: deadline.signal(),
          },
        );
        return response.levels.map((l) => ({ sku: l.sku, available: Number(l.available) }));
      },
      (err, count) => {
        unknownStock.add(count);
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err), skus: count },
          'stock unknown',
        );
      },
    );
  }
}
