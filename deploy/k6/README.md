# Load tests (k6)

One script per scenario in the [testing strategy](../../docs/engineering/testing-strategy.md#load-tests-k6). Results go to [`docs/benchmarks/`](../../docs/benchmarks/) with hardware, versions, method and raw numbers.

| Script | Scenario | Pass criteria |
|---|---|---|
| `reserve-hot-sku.js` | Flash sale (PRD J6): `ATTEMPTS` buyers (default 5,000) from `VUS` virtual users race for `STOCK` units (default 100) of one SKU | Exactly `STOCK` reserved, everything else `INSUFFICIENT_STOCK`, no other errors |
| `browse.js` | Browsing (RFC-0005 §7): `VUS` buyers (default 500) on list 50%, detail 35%, cart 15%, through the gateway with Inventory stock on every page; `THINK` seconds between requests (default 1, `0` for throughput) | List and detail p99 < 200 ms, failures < 0.1% (k6 thresholds) |
| `reserve-spread.js` | Steady checkouts: `RATE` reservations/s (default 2,000) for `DURATION` (60 s), 2–3 lines across `SKUS` (1,000) | No failures, no dropped iterations |

The `reserve-*` scripts call the Inventory gRPC API directly (`INVENTORY_ADDR`, default `localhost:9110`), so they measure Inventory alone, without the gateway. `browse.js` goes through the gateway (`GATEWAY_URL`, default `http://localhost:8100`) and seeds its own catalog through the admin API.

## Running

```bash
make demo                                   # the stack, with Inventory built from source
deploy/k6/reset-inventory.sh                # empty Inventory's tables (local stack only)
docker run --rm --network host -v "$PWD:/work" -w /work/deploy/k6 grafana/k6:1.8.2 \
  run -e INVENTORY_ADMIN_IDENTITY="$(deploy/k6/admin-identity.sh)" -e ATTEMPTS=5000 -e VUS=5000 reserve-hot-sku.js
docker exec -i sagamart-inventory-db-1 psql -U inventory -d inventory < deploy/k6/check-inventory.sql
```

Seeding (`SetStockLevel`) and stock reads (`GetStockLevels`) need the gateway's signed identity (#17). `admin-identity.sh` signs an admin one with the local key from `deploy/compose/.env`. It lasts 60 seconds, enough for `setup()` and a short run's `teardown()`, so generate it in the same command.

`check-inventory.sql` asserts the invariants after a run: nothing oversold, `reserved` equal to what active reservations hold, and one reservation per order.

`summarize-reservations.py <dir>` turns a directory of `--summary-export` JSON, `docker stats` samples and check output into the tables used in the benchmark reports.

### Browse

```bash
GATEWAY_RATE_LIMIT_PER_SECOND=100000 GATEWAY_RATE_LIMIT_BURST=100000 make demo   # one k6 host is one IP
deploy/k6/run-browse.sh bench-results/browse run1 -e VUS=500                     # k6 summary, docker stats, machine
```

The gateway's rate limiter stays on the request path, Redis call included; the raised limit only stops it refusing a benchmark that comes from one address.

## Memory

k6 needs about 0.35–0.5 MB per VU for these scripts: about 1.7 GB peak at 5,000 VUs. Check free memory before raising `VUS`.
