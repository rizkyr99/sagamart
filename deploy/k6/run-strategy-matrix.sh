#!/usr/bin/env bash
# BENCHMARK BRANCH ONLY (issue #11): runs every reservation strategy through the same scenarios.
# Usage: deploy/k6/run-strategy-matrix.sh <output dir>
set -euo pipefail
OUT=${1:?output dir}
mkdir -p "$OUT"
COMPOSE="docker compose -f deploy/compose/infra.yml -f deploy/compose/services.yml --env-file deploy/compose/.env --profile services"
K6="docker run --rm --name k6bench --user $(id -u):$(id -g) --network host -v $PWD:/work -w /work/deploy/k6 grafana/k6:1.8.2 run -q"

check() { docker exec -i sagamart-inventory-db-1 psql -q -U inventory -d inventory -tA -F'|' < deploy/k6/check-inventory.sql > "$1"; }

sample_cpu() { # samples inventory and its database while a run lasts
  while docker ps --format '{{.Names}}' | grep -q '^k6bench$'; do
    docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' sagamart-inventory-1 sagamart-inventory-db-1 sagamart-redis-1 >> "$1"
  done
}

for st in a b c; do
  INVENTORY_RESERVE_STRATEGY=$st $COMPOSE up -d --no-deps --force-recreate --wait inventory >/dev/null 2>&1
  docker logs sagamart-inventory-1 2>&1 | grep -o '"strategy":"[a-c]"' | head -1
  for rep in 1 2 3; do
    for shape in 5000 500; do
      deploy/k6/reset-inventory.sh >/dev/null
      name="$st-hot$shape-r$rep"
      (sleep 2; sample_cpu "$OUT/$name.cpu") &
      $K6 -e ATTEMPTS=5000 -e VUS=$shape --summary-export "/work/$OUT/$name.json" reserve-hot-sku.js > "$OUT/$name.log" 2>&1 || true
      wait
      check "$OUT/$name.check"
      echo "$name done"
    done
  done
  deploy/k6/reset-inventory.sh >/dev/null
  name="$st-spread"
  (sleep 25; sample_cpu "$OUT/$name.cpu") &
  $K6 --summary-export "/work/$OUT/$name.json" reserve-spread.js > "$OUT/$name.log" 2>&1 || true
  wait
  check "$OUT/$name.check"
  echo "$name done"
done
INVENTORY_RESERVE_STRATEGY=a $COMPOSE up -d --no-deps --force-recreate --wait inventory >/dev/null 2>&1
echo "matrix complete"
