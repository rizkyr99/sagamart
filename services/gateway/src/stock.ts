// Stock for display (RFC-0005 §4.4). Pure: the Inventory client fetches, these decide.

export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';

/** At or below this many available units, a SKU is LOW_STOCK. */
export const LOW_STOCK_MAX = 5;
/** The inventory contract's GetStockLevels limit. */
export const STOCK_BATCH = 100;

/** `available` is null when Inventory didn't answer for the SKU, or doesn't know it. */
export function skuStockStatus(available: number | null): StockStatus {
  if (available === null) return 'UNKNOWN';
  if (available === 0) return 'OUT_OF_STOCK';
  return available <= LOW_STOCK_MAX ? 'LOW_STOCK' : 'IN_STOCK';
}

const RANK: Record<Exclude<StockStatus, 'UNKNOWN'>, number> = { IN_STOCK: 3, LOW_STOCK: 2, OUT_OF_STOCK: 1 };

/**
 * The best known status of a product's SKUs. UNKNOWN only when none is known to be available and one is unknown,
 * because an unknown SKU might be in stock: a product isn't shown as sold out on a guess.
 */
export function productStockStatus(statuses: readonly StockStatus[]): StockStatus {
  let best: StockStatus = 'UNKNOWN';
  let unknown = statuses.length === 0;
  for (const status of statuses) {
    if (status === 'UNKNOWN') unknown = true;
    else if (best === 'UNKNOWN' || RANK[status] > RANK[best]) best = status;
  }
  if (best === 'IN_STOCK' || best === 'LOW_STOCK') return best;
  return unknown ? 'UNKNOWN' : best;
}

export interface Level {
  sku: string;
  available: number;
}

/**
 * Availability for `skus`, asked in batches of 100 in parallel. A batch that fails marks only its own SKUs null
 * (UNKNOWN) and is reported, so one slow batch never blanks the whole page.
 */
export async function lookupStock(
  skus: readonly string[],
  fetchBatch: (batch: string[]) => Promise<Level[]>,
  onFailure: (err: unknown, skuCount: number) => void = () => undefined,
): Promise<Map<string, number | null>> {
  const unique = [...new Set(skus)];
  const result = new Map<string, number | null>(unique.map((sku) => [sku, null]));
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += STOCK_BATCH) batches.push(unique.slice(i, i + STOCK_BATCH));
  await Promise.all(
    batches.map(async (batch) => {
      try {
        for (const level of await fetchBatch(batch)) {
          if (result.has(level.sku)) result.set(level.sku, level.available);
        }
      } catch (err) {
        onFailure(err, batch.length);
      }
    }),
  );
  return result;
}
