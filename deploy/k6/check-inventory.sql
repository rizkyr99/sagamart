-- Inventory invariants after a load run (testing strategy §4). Every row must report ok = true.
-- docker exec -i sagamart-inventory-db-1 psql -U inventory -d inventory < deploy/k6/check-inventory.sql

-- 1. Nothing oversold: the constraint guarantees it, this proves it held for every row.
SELECT 'no oversell' AS invariant, count(*) = 0 AS ok, count(*) AS violations
FROM stock_levels WHERE reserved < 0 OR on_hand < reserved
UNION ALL
-- 2. reserved equals what active reservations actually hold, per SKU.
SELECT 'reserved matches active reservations', count(*) = 0, count(*)
FROM stock_levels s
LEFT JOIN (
  SELECT l.sku, sum(l.quantity) AS held
  FROM reservation_lines l JOIN reservations r ON r.id = l.reservation_id
  WHERE r.status = 'ACTIVE' GROUP BY l.sku
) a ON a.sku = s.sku
WHERE s.reserved <> coalesce(a.held, 0)
UNION ALL
-- 3. One reservation per order (idempotency).
SELECT 'one reservation per order', count(*) = 0, count(*)
FROM (SELECT order_id FROM reservations GROUP BY order_id HAVING count(*) > 1) d;

-- Hot-SKU result: reserved units per SKU created by reserve-hot-sku.js.
SELECT sku, on_hand, reserved, on_hand - reserved AS available,
       (SELECT count(*) FROM reservation_lines l WHERE l.sku = s.sku) AS reservation_lines
FROM stock_levels s WHERE sku LIKE 'HOT-%' ORDER BY sku DESC LIMIT 3;
