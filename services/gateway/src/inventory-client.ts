import { createClient } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { Inject, Injectable, Logger } from '@nestjs/common';
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
export class InventoryClient {
  private readonly log = new Logger('InventoryClient');
  private readonly client: Client<typeof InventoryService>;

  constructor(
    @Inject(GATEWAY_CONFIG) config: GatewayConfig,
    private readonly internal: InternalClient,
  ) {
    this.client = createClient(InventoryService, createGrpcTransport({ baseUrl: config.inventoryUrl }));
  }

  /**
   * Available units per SKU for display; null for UNKNOWN. Never throws: browsing renders without stock
   * (RFC-0005 §4.4). All batches share `deadline`, which callers cap at 150 ms.
   */
  async availability(
    skus: readonly string[],
    caller: Caller,
    deadline: Deadline,
  ): Promise<Map<string, number | null>> {
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
