import { describe, expect, it, vi } from 'vitest';
import { lookupStock, productStockStatus, skuStockStatus } from './stock.js';

describe('skuStockStatus (RFC-0005 §4.4)', () => {
  it.each([
    [0, 'OUT_OF_STOCK'],
    [1, 'LOW_STOCK'],
    [5, 'LOW_STOCK'],
    [6, 'IN_STOCK'],
    [null, 'UNKNOWN'],
  ] as const)('%s available is %s', (available, status) => {
    expect(skuStockStatus(available)).toBe(status);
  });
});

describe('productStockStatus', () => {
  it.each([
    [['OUT_OF_STOCK', 'LOW_STOCK', 'IN_STOCK'], 'IN_STOCK'],
    [['OUT_OF_STOCK', 'LOW_STOCK'], 'LOW_STOCK'],
    [['OUT_OF_STOCK', 'OUT_OF_STOCK'], 'OUT_OF_STOCK'],
    // A known available SKU beats an unknown one: the product is buyable.
    [['UNKNOWN', 'LOW_STOCK'], 'LOW_STOCK'],
    // Nothing known to be available and something unknown: the unknown SKU might be in stock.
    [['UNKNOWN', 'OUT_OF_STOCK'], 'UNKNOWN'],
    [['UNKNOWN'], 'UNKNOWN'],
    [[], 'UNKNOWN'],
  ] as const)('%j gives %s', (statuses, expected) => {
    expect(productStockStatus(statuses)).toBe(expected);
  });
});

describe('lookupStock', () => {
  const skus = (n: number, prefix = 'S') => Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);

  it('asks in batches of at most 100, in parallel, and maps each SKU to its available units', async () => {
    const fetch = vi.fn((batch: string[]) => Promise.resolve(batch.map((sku) => ({ sku, available: 7 }))));
    const result = await lookupStock(skus(250), fetch);
    expect(fetch.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 50]);
    expect(result.size).toBe(250);
    expect(result.get('S-249')).toBe(7);
  });

  it('asks once for each SKU even if it appears twice', async () => {
    const fetch = vi.fn((batch: string[]) => Promise.resolve(batch.map((sku) => ({ sku, available: 1 }))));
    await lookupStock(['A', 'B', 'A'], fetch);
    expect(fetch).toHaveBeenCalledWith(['A', 'B']);
  });

  it('marks only the failed batch UNKNOWN (null), and reports it', async () => {
    const onFailure = vi.fn();
    const result = await lookupStock(
      skus(150),
      (batch) =>
        batch[0] === 'S-100'
          ? Promise.reject(new Error('deadline'))
          : Promise.resolve(batch.map((sku) => ({ sku, available: 3 }))),
      onFailure,
    );
    expect(result.get('S-99')).toBe(3);
    expect(result.get('S-100')).toBeNull();
    expect(result.get('S-149')).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), 50);
  });

  it('treats a SKU Inventory does not know as UNKNOWN', async () => {
    const result = await lookupStock(['KNOWN', 'NEW'], () =>
      Promise.resolve([{ sku: 'KNOWN', available: 0 }]),
    );
    expect(result.get('KNOWN')).toBe(0);
    expect(result.get('NEW')).toBeNull();
  });

  it('makes no call for no SKUs', async () => {
    const fetch = vi.fn();
    expect((await lookupStock([], fetch)).size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
