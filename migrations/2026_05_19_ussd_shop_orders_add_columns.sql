-- Add missing columns to ussd_shop_orders for richer order tracking

ALTER TABLE ussd_shop_orders
  ADD COLUMN IF NOT EXISTS profit_amount    DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS customer_email   TEXT,          -- email of dialing phone (if registered)
  ADD COLUMN IF NOT EXISTS shop_name        TEXT,          -- snapshot of user_shops.shop_name at order time
  ADD COLUMN IF NOT EXISTS shop_owner_email TEXT;          -- snapshot of shop owner's email at order time
