// Shared helpers for Inventory load tests: a gRPC client per VU, the service's RPCs, and order IDs.
import grpc from 'k6/net/grpc';

export const ADDR = __ENV.INVENTORY_ADDR || 'localhost:9110';
const SERVICE = 'sagamart.inventory.v1.InventoryService';

const client = new grpc.Client();
client.load([__ENV.PROTO_DIR || '../../contracts/proto'], 'sagamart/inventory/v1/inventory.proto');

let connected = false;
function ensureConnected() {
  if (!connected) {
    client.connect(ADDR, { plaintext: true, timeout: '10s' });
    connected = true;
  }
}

export function call(method, req) {
  ensureConnected();
  return client.invoke(`${SERVICE}/${method}`, req, { timeout: '10s' });
}

export function close() {
  if (connected) client.close();
  connected = false;
}

// orderId returns a random UUID (version 4 layout); Inventory accepts any UUID as an order ID.
export function orderId() {
  const h = [];
  for (let i = 0; i < 16; i++) h.push(Math.floor(Math.random() * 256));
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// adminCall is call() with the gateway's signed identity, which SetStockLevel and GetStockLevels require (#17).
// Pass one from admin-identity.sh as INVENTORY_ADMIN_IDENTITY; it is valid for 60 s, enough for setup and a
// short run's teardown.
export function adminCall(method, req) {
  const identity = __ENV.INVENTORY_ADMIN_IDENTITY;
  if (!identity) throw new Error('set INVENTORY_ADMIN_IDENTITY: -e INVENTORY_ADMIN_IDENTITY="$(deploy/k6/admin-identity.sh)"');
  ensureConnected();
  return client.invoke(`${SERVICE}/${method}`, req, { timeout: '10s', metadata: { 'x-sagamart-identity': identity } });
}

// seed creates SKUs with the given on-hand quantity, failing loudly if Inventory refuses.
export function seed(skus, onHand) {
  for (const sku of skus) {
    const res = adminCall('SetStockLevel', { sku, onHand, expectedVersion: 0 });
    if (res.status !== grpc.StatusOK) {
      throw new Error(`seed ${sku}: ${res.status} ${res.error && res.error.message}`);
    }
  }
  close();
}

export { grpc };
