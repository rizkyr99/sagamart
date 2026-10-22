// Flash sale (PRD J6, RFC-0001 §7 scenario 1): ATTEMPTS buyers race for STOCK units of one SKU.
// Pass: exactly STOCK reservations succeed; every other attempt is a fast INSUFFICIENT_STOCK.
//
//   docker run --rm --network host -v "$PWD:/work" -w /work/deploy/k6 grafana/k6:1.8.2 run reserve-hot-sku.js
import { Counter } from 'k6/metrics';
import { call, close, grpc, orderId, seed } from './lib/inventory.js';

const ATTEMPTS = Number(__ENV.ATTEMPTS || 5000);
const VUS = Number(__ENV.VUS || 500);
const STOCK = Number(__ENV.STOCK || 100);

const reserved = new Counter('reservations_reserved');
const soldOut = new Counter('reservations_sold_out');
const failed = new Counter('reservations_failed');

export const options = {
  scenarios: {
    flash_sale: { executor: 'shared-iterations', vus: VUS, iterations: ATTEMPTS, maxDuration: '3m' },
  },
  thresholds: {
    // Correctness: never more than STOCK sold, nothing but sold-out for the rest.
    reservations_reserved: [`count==${STOCK}`],
    reservations_failed: ['count==0'],
    // Listed so the summary reports latency per outcome (status 0 = OK, 9 = FAILED_PRECONDITION).
    'grpc_req_duration{status:0}': ['p(99)>=0'],
    'grpc_req_duration{status:9}': ['p(99)>=0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(99)', 'max'],
};

export function setup() {
  const sku = `HOT-${Date.now()}`;
  seed([sku], STOCK);
  return { sku };
}

export default function (data) {
  const res = call('ReserveStock', { orderId: orderId(), lines: [{ sku: data.sku, quantity: 1 }] });
  if (res.status === grpc.StatusOK) reserved.add(1);
  else if (res.status === grpc.StatusFailedPrecondition) soldOut.add(1);
  else failed.add(1);
}

export function teardown(data) {
  const res = call('GetStockLevels', { skus: [data.sku] });
  console.log(`final level for ${data.sku}: ${JSON.stringify(res.message)}`);
  close();
}
