-- 0122_sandbox_commission_actions.sql
-- Public API (Commission Cashback Plan B): sandbox keys can place Standard Bundle and Utility Bill test orders.
-- Additive: widens sandbox_orders.action to include 'standard_bundle' and 'utility_bill'.

BEGIN;

ALTER TABLE sandbox_orders DROP CONSTRAINT IF EXISTS sandbox_orders_action_check;
ALTER TABLE sandbox_orders ADD CONSTRAINT sandbox_orders_action_check
  CHECK (action IN ('data_order', 'airtime', 'afa', 'results_checker', 'standard_bundle', 'utility_bill'));

COMMIT;
