-- Add parent shop profit tracking to ussd_shop_orders
-- For sub-agent shops: parent_shop_id = the parent shop, parent_profit_amount = wholesale_margin
-- For direct shops: both columns are NULL / 0

ALTER TABLE ussd_shop_orders
  ADD COLUMN IF NOT EXISTS parent_shop_id       UUID REFERENCES user_shops(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_profit_amount DECIMAL(10,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ussd_shop_orders_parent_shop_id
  ON ussd_shop_orders(parent_shop_id)
  WHERE parent_shop_id IS NOT NULL;
