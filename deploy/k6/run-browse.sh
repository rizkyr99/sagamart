#!/usr/bin/env bash
# Runs browse.js and records what a benchmark report needs: k6's summary, docker stats samples and the machine.
# Usage: deploy/k6/run-browse.sh <out-dir> <name> [k6 -e flags...]
#   e.g. deploy/k6/run-browse.sh bench-results/browse run1 -e VUS=500
# Needs the stack with a raised rate limit (see browse.js). Local stack only.
set -euo pipefail
out="$1"; name="$2"; shift 2
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$out"
{ echo "date: $(date -Iseconds)"; echo "cpu: $(lscpu | sed -n 's/^Model name: *//p')"; echo "threads: $(nproc)";
  echo "memory: $(free -h | awk '/^Mem:/{print $2}')"; docker --version; } > "$out/machine.txt"
( while true; do echo "$(date +%s),$(free -m | awk '/^Mem:/{print $7}'),$(cut -d" " -f1 /proc/loadavg)"; sleep 5; done ) > "$out/$name-host.csv" &
host=$!

services="sagamart-gateway-1 sagamart-catalog-1 sagamart-inventory-1 sagamart-catalog-db-1 sagamart-inventory-db-1 sagamart-redis-1 sagamart-dynamodb-1 sagamart-otel-collector-1 sagamart-jaeger-1"
# shellcheck disable=SC2086
( while true; do docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' $services | sed "s/^/$(date +%s),/"; done ) \
  > "$out/$name-stats.csv" 2>/dev/null &
sampler=$!
trap 'kill $sampler $host 2>/dev/null || true' EXIT

docker run --rm --network host --user "$(id -u):$(id -g)" -v "$root:/work" -w /work/deploy/k6 grafana/k6:1.8.2 \
  run --summary-export "/work/$out/$name-summary.json" "$@" browse.js | tee "$out/$name-k6.txt"
