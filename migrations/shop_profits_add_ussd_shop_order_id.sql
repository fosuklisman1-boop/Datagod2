-- Add ussd_shop_order_id reference to shop_profits
-- Allows profits from the USSD shop-code storefront to be linked back to their source order.
-- No FK constraint: ussd_shop_orders is a separate table from ussd_orders.

ALTER TABLE shop_profits
  ADD COLUMN IF NOT EXISTS ussd_shop_order_id UUID;

CREATE INDEX IF NOT EXISTS idx_shop_profits_ussd_shop_order_id
  ON shop_profits(ussd_shop_order_id)
  WHERE ussd_shop_order_id IS NOT NULL;
