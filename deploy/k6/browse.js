// Browse load test (testing strategy §3, RFC-0005 §7): 500 VUs on a read-heavy mix through the gateway, with stock
// from Inventory on every page. Target: product list and detail p99 < 200 ms, failures < 0.1%.
//
// Seeds its own catalog through the public admin API, so run it against a stack whose rate limit is raised (one
// k6 host is one IP): GATEWAY_RATE_LIMIT_PER_SECOND=100000 GATEWAY_RATE_LIMIT_BURST=100000 make demo
import http from 'k6/http';
import { check, sleep } from 'k6';

const GATEWAY = __ENV.GATEWAY_URL || 'http://localhost:8100';
const PRODUCTS = Number(__ENV.PRODUCTS || 200);
const VUS = Number(__ENV.VUS || 500);
const HOLD = __ENV.HOLD || '2m';
// Seconds a buyer pauses between requests, on average: people read pages. 0 makes it a throughput test.
const THINK = Number(__ENV.THINK ?? 1);

export const options = {
  setupTimeout: '5m',
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: VUS },
        { duration: HOLD, target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    'http_req_duration{name:list}': ['p(99)<200'],
    'http_req_duration{name:detail}': ['p(99)<200'],
    'http_req_failed{scenario:browse}': ['rate<0.001'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const json = { 'content-type': 'application/json' };
const run = Date.now().toString(36);

function must(res, what) {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${res.body}`);
  return res.json();
}

// ---- Setup: a catalog of PRODUCTS products, three sizes each, with stock in, low and out ----

export function setup() {
  const userId = '0199f2e0-0000-7000-8000-00000000b001';
  const { token } = must(http.post(`${GATEWAY}/v1/dev/token`, JSON.stringify({ role: 'admin', userId }), { headers: json }), 'token');
  const admin = (key) => ({ headers: { ...json, authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) } });

  const category = must(
    http.post(`${GATEWAY}/v1/admin/categories`, JSON.stringify({ slug: `bench-${run}`, name: 'Bench' }), admin(`bench-cat-${run}`)),
    'category',
  );
  const slugs = [];
  const skus = [];
  for (let i = 0; i < PRODUCTS; i++) {
    const slug = `bench-${run}-${i}`;
    const sizes = ['S', 'M', 'L'].map((size, j) => ({
      sku: `BENCH-${run}-${i}-${size}`.toUpperCase(),
      name: size,
      price: { amount: 50_000 + ((i * 7 + j) % 40) * 1_000, currency: 'IDR' },
    }));
    must(
      http.post(
        `${GATEWAY}/v1/admin/products`,
        JSON.stringify({ slug, name: `Bench ${i}`, categoryId: category.id, status: 'ACTIVE', skus: sizes }),
        admin(`bench-product-${run}-${i}`),
      ),
      `product ${i}`,
    );
    sizes.forEach((s, j) => {
      const onHand = [0, 3, 40][(i + j) % 3]; // out, low and in stock across the catalog
      must(http.put(`${GATEWAY}/v1/admin/skus/${s.sku}/stock`, JSON.stringify({ onHand, expectedVersion: 0 }), admin()), `stock ${s.sku}`);
    });
    slugs.push(slug);
    skus.push(...sizes.map((s) => s.sku));
  }
  return { category: `bench-${run}`, slugs, skus };
}

// ---- Buyers: list 50%, detail 35%, cart 15% (RFC-0005 §7) ----

const pick = (items) => items[Math.floor(Math.random() * items.length)];
let cartToken = null; // per VU: one guest cart each

function list(data) {
  const sort = pick(['newest', 'price_asc', 'price_desc']);
  const query = Math.random() < 0.5 ? `?sort=${sort}` : `?sort=${sort}&category=${data.category}`;
  const res = http.get(`${GATEWAY}/v1/products${query}`, { tags: { name: 'list' } });
  check(res, { 'list 200': (r) => r.status === 200 });
  // Some buyers look at the next page.
  if (res.status === 200 && Math.random() < 0.2) {
    const next = res.json('nextCursor');
    if (next) {
      const page2 = http.get(`${GATEWAY}/v1/products${query}&cursor=${encodeURIComponent(next)}`, { tags: { name: 'list' } });
      check(page2, { 'list page 2 200': (r) => r.status === 200 });
    }
  }
}

function detail(data) {
  const res = http.get(`${GATEWAY}/v1/products/${pick(data.slugs)}`, { tags: { name: 'detail' } });
  check(res, { 'detail 200': (r) => r.status === 200 });
}

function cart(data) {
  if (!cartToken) {
    cartToken = http.post(`${GATEWAY}/v1/cart/guest-token`, null, { tags: { name: 'cart' } }).json('token');
  }
  const headers = { ...json, 'x-cart-token': cartToken };
  const res =
    Math.random() < 0.5
      ? http.put(`${GATEWAY}/v1/cart/lines/${pick(data.skus)}`, JSON.stringify({ quantity: 1 + Math.floor(Math.random() * 3) }), { headers, tags: { name: 'cart' } })
      : http.get(`${GATEWAY}/v1/cart`, { headers, tags: { name: 'cart' } });
  // A full cart (50 lines) is a legitimate 422, not a failure of the system.
  check(res, { 'cart ok': (r) => r.status === 200 || r.status === 422 });
}

export default function (data) {
  const r = Math.random();
  if (r < 0.5) list(data);
  else if (r < 0.85) detail(data);
  else cart(data);
  if (THINK > 0) sleep(THINK * (0.5 + Math.random()));
}
