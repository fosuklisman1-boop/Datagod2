-- Add profit_amount to ussd_shop_orders
-- profit_amount = shop_packages.profit_margin (the shop owner's markup, snapshotted at order creation)
-- amount already stores the full retail price (packages.price + profit_margin)

ALTER TABLE ussd_shop_orders
  ADD COLUMN IF NOT EXISTS profit_amount DECIMAL(10,2) NOT NULL DEFAULT 0;
