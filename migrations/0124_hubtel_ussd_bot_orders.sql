-- 0124_hubtel_ussd_bot_orders.sql
-- Commission cashback Bots Plan 2 (Hubtel USSD): the Hubtel USSD checkout may now carry bot Utility Bill
-- (hubtel_bill_orders) and Network Plan (hubtel_data_orders) orders. Widens the order_table CHECK on
-- hubtel_transactions so their AddToCart rows can be recorded.
-- ADDITIVE; service-role only. NOT applied by the implementing agent. Apply AFTER 0123 and BEFORE deploying the
-- Hubtel USSD bot menus (a CONFIRM for a bot order fails at the hubtel_transactions insert until this is applied).
-- One transaction. Idempotent (re-runnable).
--
-- The CHECK is the inline one from 0106, auto-named hubtel_transactions_order_table_check.
--
-- PRE-CHECK:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'hubtel_transactions_order_table_check';
--     -- expect the 0106 list: ussd_orders, ussd_shop_orders, airtime_orders, results_checker_orders,
--     --                       results_check_requests, ussd_afa_orders
--
-- POST-CHECK:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'hubtel_transactions_order_table_check';
--     -- the 0106 list plus hubtel_bill_orders, hubtel_data_orders
--
-- Keep in sync with lib/ussd-hubtel/order-tables.ts (pinned by order-tables.test.ts).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.hubtel_transactions DROP CONSTRAINT IF EXISTS hubtel_transactions_order_table_check;
ALTER TABLE public.hubtel_transactions ADD CONSTRAINT hubtel_transactions_order_table_check
  CHECK (order_table IN (
    'ussd_orders','ussd_shop_orders','airtime_orders',
    'results_checker_orders','results_check_requests','ussd_afa_orders',
    'hubtel_bill_orders','hubtel_data_orders'));

COMMIT;
