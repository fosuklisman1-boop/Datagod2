-- 1. Revert manual airtime_order_id column
ALTER TABLE wallet_payments DROP COLUMN IF EXISTS airtime_order_id;

-- 2. Remove the strict FK constraint that limits order_id to shop_orders
-- Common names are fk_wallet_payments_order_id or wallet_payments_order_id_fkey
ALTER TABLE wallet_payments DROP CONSTRAINT IF EXISTS fk_wallet_payments_order_id;
ALTER TABLE wallet_payments DROP CONSTRAINT IF EXISTS wallet_payments_order_id_fkey;

-- 3. Add order_type to track data vs airtime (Defaulting to 'data')
ALTER TABLE wallet_payments ADD COLUMN IF NOT EXISTS order_type TEXT DEFAULT 'data';

-- 4. Ensure user_id is nullable (required for guest checkout)
ALTER TABLE wallet_payments ALTER COLUMN user_id DROP NOT NULL;
