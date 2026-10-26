-- 0134_leaderboard_indexes.sql
--
-- Run the whole file once, after 1_leaderboard_engine.sql. Tables your database
-- does not have are skipped. Each index briefly blocks WRITES to its table while
-- it builds (seconds for these partial indexes), so run it at a quiet time.
-- If a table is busy it gives up after 5s instead of queueing orders behind it:
-- just run the file again (indexes already built are skipped).
-- Optional for correctness: they only make the 5-minute refresh fast.

SET lock_timeout = '5s';
SET statement_timeout = '300s';

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('lb_orders_completed_idx', 'orders', $w$status = 'completed'$w$),
    ('lb_api_orders_completed_idx', 'api_orders', $w$status = 'completed'$w$),
    ('lb_airtime_orders_completed_idx', 'airtime_orders', $w$status = 'completed'$w$),
    ('lb_afa_orders_completed_idx', 'afa_orders', $w$status = 'completed'$w$),
    ('lb_results_checker_orders_completed_idx', 'results_checker_orders', $w$status = 'completed'$w$),
    ('lb_hubtel_bill_orders_completed_idx', 'hubtel_bill_orders', $w$status = 'completed'$w$),
    ('lb_hubtel_data_orders_completed_idx', 'hubtel_data_orders', $w$status = 'completed'$w$),
    ('lb_shop_orders_completed_idx', 'shop_orders', $w$order_status = 'completed' AND payment_status = 'completed'$w$),
    ('lb_ussd_shop_orders_completed_idx', 'ussd_shop_orders', $w$order_status = 'completed' AND payment_status = 'completed'$w$)
  ) AS v(index_name, table_name, predicate)
  LOOP
    IF to_regclass('public.' || r.table_name) IS NULL THEN
      RAISE NOTICE 'skipped %: table % not found', r.index_name, r.table_name;
    ELSE
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (public.lb_ts(created_at)) WHERE %s',
                     r.index_name, r.table_name, r.predicate);
      RAISE NOTICE 'ok %', r.index_name;
    END IF;
  END LOOP;
END $$;

SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'lb_%' ORDER BY 1;
