-- Add sub-agent parent profit tracking to ussd_orders
ALTER TABLE ussd_orders
  ADD COLUMN IF NOT EXISTS parent_shop_id       UUID REFERENCES user_shops(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_profit_amount DECIMAL(10,2);

CREATE INDEX IF NOT EXISTS idx_ussd_orders_parent_shop ON ussd_orders(parent_shop_id)
  WHERE parent_shop_id IS NOT NULL;
