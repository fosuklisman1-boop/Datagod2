-- Migration: Enable ON DELETE CASCADE for all shop_id foreign keys referencing user_shops
-- Adjust constraint names if your DB uses different ones

ALTER TABLE shop_orders
DROP CONSTRAINT IF EXISTS shop_orders_shop_id_fkey,
ADD CONSTRAINT shop_orders_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES user_shops(id) ON DELETE CASCADE;

ALTER TABLE shop_profits
DROP CONSTRAINT IF EXISTS shop_profits_shop_id_fkey,
ADD CONSTRAINT shop_profits_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES user_shops(id) ON DELETE CASCADE;

ALTER TABLE shop_available_balance
DROP CONSTRAINT IF EXISTS shop_available_balance_shop_id_fkey,
ADD CONSTRAINT shop_available_balance_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES user_shops(id) ON DELETE CASCADE;

ALTER TABLE sub_agent_shop_packages
DROP CONSTRAINT IF EXISTS sub_agent_shop_packages_shop_id_fkey,
ADD CONSTRAINT sub_agent_shop_packages_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES user_shops(id) ON DELETE CASCADE;

ALTER TABLE shop_settings
DROP CONSTRAINT IF EXISTS shop_settings_shop_id_fkey,
ADD CONSTRAINT shop_settings_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES user_shops(id) ON DELETE CASCADE;

ALTER TABLE withdrawal_requests
DROP CONSTRAINT IF EXISTS withdrawal_requests_shop_id_fkey,
ADD CONSTRAINT withdrawal_requests_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES user_shops(id) ON DELETE CASCADE;

ALTER TABLE wallet_payments
DROP CONSTRAINT IF EXISTS wallet_payments_shop_id_fkey,
ADD CONSTRAINT wallet_payments_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES user_shops(id) ON DELETE CASCADE;

ALTER TABLE payment_attempts
DROP CONSTRAINT IF EXISTS payment_attempts_shop_id_fkey,
ADD CONSTRAINT payment_attempts_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES user_shops(id) ON DELETE CASCADE;
