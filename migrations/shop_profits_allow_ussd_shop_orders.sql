-- Ensure shop_profits can hold records from ussd_shop_orders.
-- Safe to re-run (all statements are idempotent).

-- 1. Make shop_order_id nullable so profits without a shop_orders FK can be inserted.
--    (Mirrors profit_disbursement_v1.sql — re-applying is a no-op if already done.)
ALTER TABLE shop_profits ALTER COLUMN shop_order_id DROP NOT NULL;

-- 2. Add ussd_shop_order_id reference column if not already present.
ALTER TABLE shop_profits
  ADD COLUMN IF NOT EXISTS ussd_shop_order_id UUID;

CREATE INDEX IF NOT EXISTS idx_shop_profits_ussd_shop_order_id
  ON shop_profits(ussd_shop_order_id)
  WHERE ussd_shop_order_id IS NOT NULL;
