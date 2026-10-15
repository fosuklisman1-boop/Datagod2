-- 0125_hubtel_ussd_bot_orders.sql
-- Commission cashback Bots Plan 2 (Hubtel USSD): the Hubtel USSD checkout may now carry bot Utility Bill
-- (hubtel_bill_orders) and Network Plan (hubtel_data_orders) orders. Widens the order_table CHECK on
-- hubtel_transactions so their AddToCart rows can be recorded.
-- ADDITIVE; service-role only. NOT applied by the implementing agent. Apply AFTER 0123 and BEFORE deploying the
-- Hubtel USSD bot menus (a CONFIRM for a bot order fails at the hubtel_transactions insert until this is applied).
-- One transaction. Idempotent (re-runnable). Run at a quiet time: the ADD CONSTRAINT scans the table under an
-- ACCESS EXCLUSIVE lock (USSD CONFIRM inserts wait behind it; lock_timeout 5s makes it fail safe, not hang).
--
-- The CHECK is the inline one from 0106, auto-named hubtel_transactions_order_table_check. If production's name
-- differs, DROP ... IF EXISTS would silently no-op and the old CHECK would keep rejecting the new values: the
-- assertion block at the end then RAISES and the whole migration rolls back (fails loudly).
--
-- PRE-CHECK (every CHECK on the table, not just the expected name; expect exactly ONE mentioning order_table,
-- named hubtel_transactions_order_table_check, with the 0106 list):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.hubtel_transactions'::regclass AND contype = 'c'
--    ORDER BY conname;
--     -- 0106 list: ussd_orders, ussd_shop_orders, airtime_orders, results_checker_orders,
--     --            results_check_requests, ussd_afa_orders
--   If the order_table CHECK has a different name, STOP: edit the DROP below to that name first.
--
-- POST-CHECK (same query): exactly one CHECK mentioning order_table, hubtel_transactions_order_table_check,
--   with the 0106 list plus hubtel_bill_orders, hubtel_data_orders.
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

-- Assertion: the ONLY CHECK on hubtel_transactions that mentions order_table is the widened one. Another one
-- (an old CHECK under a different name) would still reject the bot tables: abort the whole migration.
DO $$
DECLARE
  v_names text;
  v_count integer;
BEGIN
  SELECT count(*), string_agg(conname || ': ' || pg_get_constraintdef(oid), E'\n' ORDER BY conname)
    INTO v_count, v_names
    FROM pg_constraint
   WHERE conrelid = 'public.hubtel_transactions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%order_table%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '0125: expected exactly one order_table CHECK on hubtel_transactions, found %:%', v_count, E'\n' || COALESCE(v_names, '(none)');
  END IF;
  IF v_names NOT LIKE 'hubtel_transactions_order_table_check:%'
     OR v_names NOT LIKE '%hubtel_bill_orders%' OR v_names NOT LIKE '%hubtel_data_orders%' THEN
    RAISE EXCEPTION '0125: the order_table CHECK is not the widened one: %', v_names;
  END IF;
END $$;

COMMIT;
