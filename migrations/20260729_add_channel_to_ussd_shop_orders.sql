-- Add `channel` to ussd_shop_orders so the WhatsApp shop bot (Task 1.3+) can
-- tag its orders the same way airtime_orders / results_checker_orders already
-- do (see migrations/20260608_ussd_airtime_results_checker.sql). Existing
-- USSD-shop rows default to 'ussd_shop' — nothing already in this table was
-- created by any other channel.
ALTER TABLE public.ussd_shop_orders
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'ussd_shop';
