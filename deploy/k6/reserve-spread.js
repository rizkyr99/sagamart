// Steady checkout load (RFC-0001 §7 scenario 2): RATE reservations/s, each 2-3 random SKUs out of SKUS,
// with plenty of stock, so this measures throughput and latency without hot-row contention.
//
//   docker run --rm --network host -v "$PWD:/work" -w /work/deploy/k6 grafana/k6:1.8.2 run reserve-spread.js
import { Counter } from 'k6/metrics';
import { call, close, grpc, orderId, seed } from './lib/inventory.js';

const RATE = Number(__ENV.RATE || 2000);
const DURATION = __ENV.DURATION || '60s';
const SKUS = Number(__ENV.SKUS || 1000);

const reserved = new Counter('reservations_reserved');
const failed = new Counter('reservations_failed');

export const options = {
  scenarios: {
    checkout: {
      executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: Number(__ENV.VUS || 300), maxVUs: Number(__ENV.MAX_VUS || 1000),
    },
  },
  thresholds: {
    reservations_failed: ['count==0'],
    dropped_iterations: ['count==0'], // the service kept up with the arrival rate
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(99)', 'max'],
};

export function setup() {
  const prefix = `SPREAD-${Date.now()}`;
  const skus = Array.from({ length: SKUS }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);
  seed(skus, 1000000);
  return { skus };
}

export default function (data) {
  const n = 2 + Math.floor(Math.random() * 2);
  const picked = new Set();
  while (picked.size < n) picked.add(data.skus[Math.floor(Math.random() * data.skus.length)]);
  const lines = [...picked].map((sku) => ({ sku, quantity: 1 + Math.floor(Math.random() * 3) }));

  const res = call('ReserveStock', { orderId: orderId(), lines });
  if (res.status === grpc.StatusOK) reserved.add(1);
  else failed.add(1);
}
