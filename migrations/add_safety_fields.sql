ALTER TABLE airtime_orders ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT false;
ALTER TABLE airtime_orders ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(20);
