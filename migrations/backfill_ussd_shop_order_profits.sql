-- Backfill missing shop_profits records for completed ussd_shop_orders.
-- Safe to re-run: uses WHERE NOT EXISTS to skip orders already credited.
--
-- Covers two cases per order:
--   1. Sub-agent (or direct shop) profit  → profit_amount
--   2. Parent shop wholesale margin        → parent_profit_amount (sub-agent orders only)

-- ── 1. Sub-agent / direct shop profit ────────────────────────────────────────
INSERT INTO shop_profits (shop_id, ussd_shop_order_id, profit_amount, status, created_at)
SELECT
  o.shop_id,
  o.id,
  o.profit_amount,
  'credited',
  o.updated_at   -- use the order's completion timestamp as credit time
FROM ussd_shop_orders o
WHERE o.payment_status = 'completed'
  AND o.profit_amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM shop_profits sp
    WHERE sp.ussd_shop_order_id = o.id
      AND sp.shop_id = o.shop_id
  );

-- ── 2. Parent shop wholesale margin (sub-agent orders only) ──────────────────
INSERT INTO shop_profits (shop_id, ussd_shop_order_id, profit_amount, status, created_at)
SELECT
  o.parent_shop_id,
  o.id,
  o.parent_profit_amount,
  'credited',
  o.updated_at
FROM ussd_shop_orders o
WHERE o.payment_status = 'completed'
  AND o.parent_shop_id IS NOT NULL
  AND o.parent_profit_amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM shop_profits sp
    WHERE sp.ussd_shop_order_id = o.id
      AND sp.shop_id = o.parent_shop_id
  );

-- ── 3. Verify: show count of records inserted per shop ───────────────────────
SELECT
  u.shop_name,
  sp.shop_id,
  COUNT(*)          AS profits_credited,
  SUM(sp.profit_amount) AS total_credited
FROM shop_profits sp
JOIN user_shops u ON u.id = sp.shop_id
WHERE sp.ussd_shop_order_id IS NOT NULL
GROUP BY u.shop_name, sp.shop_id
ORDER BY total_credited DESC;
