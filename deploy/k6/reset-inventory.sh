#!/usr/bin/env bash
# Empties Inventory's tables (and the Redis mirror used by strategy C) so each benchmark run starts clean.
# Local Compose stack only: never point this at anything that matters.
set -euo pipefail
docker exec -i sagamart-inventory-db-1 psql -q -U inventory -d inventory -c \
  'TRUNCATE reservation_lines, reservations, stock_levels, outbox' -c 'VACUUM ANALYZE'
docker exec sagamart-redis-1 redis-cli FLUSHDB >/dev/null
echo "inventory reset"
