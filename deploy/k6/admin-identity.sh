#!/usr/bin/env bash
# Prints an admin x-sagamart-identity for Inventory, signed with the local gateway key from deploy/compose/.env
# (make identity-keys). Load tests seed stock with SetStockLevel, which needs the admin role (#17).
# Valid for 60 seconds: generate it right before `k6 run`, whose setup() seeds first. Local stack only.
# Needs Node and pnpm on the host, as the Node workspace does.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
set -a
# shellcheck source=/dev/null
. "$root/deploy/compose/.env"
set +a
lib="$root/packages/node-common/dist/index.js"
# make demo builds node-common only inside Docker; build it on the host once if this checkout hasn't.
if [ ! -f "$lib" ]; then
  echo "building @sagamart/node-common on the host (first run only)..." >&2
  (cd "$root" && pnpm install --frozen-lockfile --filter @sagamart/node-common >&2 \
    && pnpm --filter @sagamart/node-common build >&2)
fi
NODE_COMMON="$lib" node --input-type=module -e '
const { signIdentity } = await import(process.env.NODE_COMMON);
process.stdout.write(signIdentity({
  privateKey: process.env.IDENTITY_PRIVATE_KEY,
  keyId: process.env.IDENTITY_KEY_ID,
  audience: "inventory",
  roles: ["admin"],
  subject: "0199f2e0-0000-7000-8000-000000000006",
}));'
