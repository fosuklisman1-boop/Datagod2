-- 0134_leaderboard_indexes.sql
--
-- Indexes that keep refresh_leaderboard_totals (0133) cheap. Partial on the
-- completed state each branch of leaderboard_sales_events filters on, keyed on
-- the same lb_ts(created_at) expression the refresh filters by.
--
-- CONCURRENTLY: run statement by statement OUTSIDE a transaction (no BEGIN),
-- after 0133 is applied. Safe to re-run; a failed CONCURRENTLY build leaves an
-- INVALID index, drop it and run that statement again.

CREATE INDEX CONCURRENTLY IF NOT EXISTS lb_orders_completed_idx
  ON public.orders (public.lb_ts(created_at)) WHERE status = 'completed';
CREATE INDEX CONCURRENTLY IF NOT EXISTS lb_api_orders_completed_idx
  ON public.api_orders (public.lb_ts(created_at)) WHERE status = 'completed';
CREATE INDEX CONCURRENTLY IF NOT EXISTS lb_airtime_orders_completed_idx
  ON public.airtime_orders (public.lb_ts(created_at)) WHERE status = 'completed';
CREATE INDEX CONCURRENTLY IF NOT EXISTS lb_afa_orders_completed_idx
  ON public.afa_orders (public.lb_ts(created_at)) WHERE status = 'completed';
CREATE INDEX CONCURRENTLY IF NOT EXISTS lb_results_checker_orders_completed_idx
  ON public.results_checker_orders (public.lb_ts(created_at)) WHERE status = 'completed';
CREATE INDEX CONCURRENTLY IF NOT EXISTS lb_hubtel_bill_orders_completed_idx
  ON public.hubtel_bill_orders (public.lb_ts(created_at)) WHERE status = 'completed';
CREATE INDEX CONCURRENTLY IF NOT EXISTS lb_hubtel_data_orders_completed_idx
  ON public.hubtel_data_orders (public.lb_ts(created_at)) WHERE status = 'completed';
CREATE INDEX CONCURRENTLY IF NOT EXISTS lb_shop_orders_completed_idx
  ON public.shop_orders (public.lb_ts(created_at)) WHERE order_status = 'completed' AND payment_status = 'completed';
CREATE INDEX CONCURRENTLY IF NOT EXISTS lb_ussd_shop_orders_completed_idx
  ON public.ussd_shop_orders (public.lb_ts(created_at)) WHERE order_status = 'completed' AND payment_status = 'completed';
