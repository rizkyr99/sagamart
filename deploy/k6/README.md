# Load tests (k6)

One script per scenario in the [testing strategy](../../docs/engineering/testing-strategy.md#load-tests-k6). Results go to [`docs/benchmarks/`](../../docs/benchmarks/) with hardware, versions, method and raw numbers.

| Script | Scenario | Pass criteria |
|---|---|---|
| `reserve-hot-sku.js` | Flash sale (PRD J6): `ATTEMPTS` buyers (default 5,000) from `VUS` virtual users race for `STOCK` units (default 100) of one SKU | Exactly `STOCK` reserved, everything else `INSUFFICIENT_STOCK`, no other errors |
| `reserve-spread.js` | Steady checkouts: `RATE` reservations/s (default 2,000) for `DURATION` (60 s), 2–3 lines across `SKUS` (1,000) | No failures, no dropped iterations |

The scripts call the Inventory gRPC API directly (`INVENTORY_ADDR`, default `localhost:9110`), so they measure Inventory alone, without the gateway.

## Running

```bash
make demo                                   # the stack, with Inventory built from source
deploy/k6/reset-inventory.sh                # empty Inventory's tables (local stack only)
docker run --rm --network host -v "$PWD:/work" -w /work/deploy/k6 grafana/k6:1.8.2 \
  run -e ATTEMPTS=5000 -e VUS=5000 reserve-hot-sku.js
docker exec -i sagamart-inventory-db-1 psql -U inventory -d inventory < deploy/k6/check-inventory.sql
```

`check-inventory.sql` asserts the invariants after a run: nothing oversold, `reserved` equal to what active reservations hold, and one reservation per order.

`summarize-reservations.py <dir>` turns a directory of `--summary-export` JSON, `docker stats` samples and check output into the tables used in the benchmark reports.

## Memory

k6 needs about 0.35–0.5 MB per VU for these scripts: about 1.7 GB peak at 5,000 VUs. Check free memory before raising `VUS`.
