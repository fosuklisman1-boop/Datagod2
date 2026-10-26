-- 0133_leaderboard_engine.sql
--
-- Leaderboard ranking engine (Phase 1 of
-- docs/superpowers/plans/2026-10-26-leaderboard-rewards.md).
--
--   shop_orders.is_stock_purchase       new flag + best-effort backfill
--   leaderboard_sales_events            view: every completed sale, one shape
--   leaderboard_daily_totals            rollup the leaderboards read
--   leaderboard_exclusions              users hidden from every board
--   refresh_leaderboard_totals(from,to) rebuilds the rollup for a day range
--   get_leaderboard(board,from,to,n)    top N for any day range
--   get_leaderboard_rank(user,board,..) one user's rank + gaps
--
-- Boards. A row that carries a shop_id is a SHOP sale credited to the shop
-- owner (user_shops.user_id); a row with only a user_id is a DASHBOARD sale
-- credited to that user. Sub-agents compete standalone: their shop sales are
-- credited to their own shop, parent_shop_id / parent_profit_amount are
-- ignored. A sub-agent's stock purchase (Buy Stock) is their own purchase, so
-- it counts on THEIR dashboard board and on no shop board.
--
-- Money is what the buyer paid for completed orders only. Standard bundles are
-- not read from hubtel_cs_transactions: those mirror into the order tables
-- below, so reading them too would double count.
--
-- Days are Africa/Accra calendar days (UTC+0, no DST). lb_ts() is overloaded
-- so a timestamp-without-time-zone column (stored as UTC) and a timestamptz
-- column both become the same instant, whichever type production has.
--
-- SECURITY DEFINER functions with a pinned search_path, executable by
-- service_role only. The view and tables have RLS on / no grants to anon or
-- authenticated: user-facing reads go through API routes that mask names.
--
-- NOT YET APPLIED: dry run via 0133_leaderboard_engine.selftest.sql first,
-- then apply, then 0134_leaderboard_indexes.sql (CONCURRENTLY, no transaction),
-- then backfill with scripts/leaderboard-backfill.ts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ───────────────────────── stock purchase flag ─────────────────────────
-- Constant default: metadata-only add, no table rewrite.
ALTER TABLE public.shop_orders
  ADD COLUMN IF NOT EXISTS is_stock_purchase boolean NOT NULL DEFAULT false;

-- Best-effort history: Buy Stock orders sit on the buyer's own sub-agent
-- shop with zero profit and the buyer's email (or the page's fallback email).
UPDATE public.shop_orders so
   SET is_stock_purchase = true
  FROM public.user_shops us
  JOIN public.users u ON u.id = us.user_id
 WHERE so.shop_id = us.id
   AND us.parent_shop_id IS NOT NULL
   AND so.is_stock_purchase = false
   AND COALESCE(so.profit_amount, 0) = 0
   AND (lower(so.customer_email) = lower(u.email) OR so.customer_email = 'sub-agent@datagod.com');

-- ───────────────────────── timestamp helper ─────────────────────────
CREATE OR REPLACE FUNCTION public.lb_ts(ts timestamp without time zone)
RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT ts AT TIME ZONE 'UTC' $$;

CREATE OR REPLACE FUNCTION public.lb_ts(ts timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT ts $$;

-- ───────────────────────── tables ─────────────────────────
CREATE TABLE IF NOT EXISTS public.leaderboard_daily_totals (
  board         text          NOT NULL CHECK (board IN ('dashboard','shop')),
  day           date          NOT NULL,
  user_id       uuid          NOT NULL,
  total_amount  numeric(14,2) NOT NULL DEFAULT 0,
  order_count   integer       NOT NULL DEFAULT 0,
  last_sale_at  timestamptz,
  refreshed_at  timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (board, day, user_id)
);
CREATE INDEX IF NOT EXISTS leaderboard_daily_totals_user_idx
  ON public.leaderboard_daily_totals (user_id, board, day);

CREATE TABLE IF NOT EXISTS public.leaderboard_exclusions (
  user_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  reason      text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.leaderboard_daily_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_exclusions   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leaderboard_daily_totals FROM anon, authenticated;
REVOKE ALL ON public.leaderboard_exclusions   FROM anon, authenticated;

-- ───────────────────────── sales events view ─────────────────────────
CREATE OR REPLACE VIEW public.leaderboard_sales_events WITH (security_invoker = true) AS
-- Dashboard board: the user's own purchases
SELECT 'dashboard'::text AS board, o.user_id, o.price::numeric AS amount,
       public.lb_ts(o.created_at) AS sold_at, 'orders'::text AS source_table, o.id::text AS order_id
  FROM public.orders o
 WHERE o.status = 'completed' AND o.user_id IS NOT NULL
UNION ALL
SELECT 'dashboard', ao.user_id, ao.price::numeric,
       public.lb_ts(ao.created_at), 'api_orders', ao.id::text
  FROM public.api_orders ao
 WHERE ao.status = 'completed'
UNION ALL
SELECT 'dashboard', air.user_id, COALESCE(air.paid_amount, air.total_paid)::numeric,
       public.lb_ts(air.created_at), 'airtime_orders', air.id::text
  FROM public.airtime_orders air
 WHERE air.status = 'completed' AND air.shop_id IS NULL AND air.user_id IS NOT NULL
UNION ALL
SELECT 'dashboard', afa.user_id, afa.amount::numeric,
       public.lb_ts(afa.created_at), 'afa_orders', afa.id::text
  FROM public.afa_orders afa
 WHERE afa.status = 'completed'
UNION ALL
SELECT 'dashboard', rc.user_id, rc.total_paid::numeric,
       public.lb_ts(rc.created_at), 'results_checker_orders', rc.id::text
  FROM public.results_checker_orders rc
 WHERE rc.status = 'completed' AND rc.shop_id IS NULL AND rc.user_id IS NOT NULL
UNION ALL
SELECT 'dashboard', hb.user_id, COALESCE(hb.paid_amount, hb.amount)::numeric,
       public.lb_ts(hb.created_at), 'hubtel_bill_orders', hb.id::text
  FROM public.hubtel_bill_orders hb
 WHERE hb.status = 'completed' AND hb.shop_id IS NULL AND hb.user_id IS NOT NULL
UNION ALL
SELECT 'dashboard', hd.user_id, COALESCE(hd.paid_amount, hd.amount)::numeric,
       public.lb_ts(hd.created_at), 'hubtel_data_orders', hd.id::text
  FROM public.hubtel_data_orders hd
 WHERE hd.status = 'completed' AND hd.shop_id IS NULL AND hd.user_id IS NOT NULL
UNION ALL
-- sub-agent stock purchases: the sub-agent's own purchase
SELECT 'dashboard', us.user_id, so.total_price::numeric,
       public.lb_ts(so.created_at), 'shop_orders', so.id::text
  FROM public.shop_orders so
  JOIN public.user_shops us ON us.id = so.shop_id
 WHERE so.is_stock_purchase
   AND so.order_status = 'completed' AND so.payment_status = 'completed'
UNION ALL
-- Shop board: customer sales, credited to the shop owner
SELECT 'shop', us.user_id, so.total_price::numeric,
       public.lb_ts(so.created_at), 'shop_orders', so.id::text
  FROM public.shop_orders so
  JOIN public.user_shops us ON us.id = so.shop_id
 WHERE NOT so.is_stock_purchase
   AND so.order_status = 'completed' AND so.payment_status = 'completed'
UNION ALL
SELECT 'shop', us.user_id, uso.amount::numeric,
       public.lb_ts(uso.created_at), 'ussd_shop_orders', uso.id::text
  FROM public.ussd_shop_orders uso
  JOIN public.user_shops us ON us.id = uso.shop_id
 WHERE uso.order_status = 'completed' AND uso.payment_status = 'completed'
UNION ALL
SELECT 'shop', us.user_id, COALESCE(air.paid_amount, air.total_paid)::numeric,
       public.lb_ts(air.created_at), 'airtime_orders', air.id::text
  FROM public.airtime_orders air
  JOIN public.user_shops us ON us.id = air.shop_id
 WHERE air.status = 'completed'
UNION ALL
SELECT 'shop', us.user_id, rc.total_paid::numeric,
       public.lb_ts(rc.created_at), 'results_checker_orders', rc.id::text
  FROM public.results_checker_orders rc
  JOIN public.user_shops us ON us.id = rc.shop_id
 WHERE rc.status = 'completed'
UNION ALL
SELECT 'shop', us.user_id, COALESCE(hb.paid_amount, hb.amount)::numeric,
       public.lb_ts(hb.created_at), 'hubtel_bill_orders', hb.id::text
  FROM public.hubtel_bill_orders hb
  JOIN public.user_shops us ON us.id = hb.shop_id
 WHERE hb.status = 'completed'
UNION ALL
SELECT 'shop', us.user_id, COALESCE(hd.paid_amount, hd.amount)::numeric,
       public.lb_ts(hd.created_at), 'hubtel_data_orders', hd.id::text
  FROM public.hubtel_data_orders hd
  JOIN public.user_shops us ON us.id = hd.shop_id
 WHERE hd.status = 'completed';

REVOKE ALL ON public.leaderboard_sales_events FROM anon, authenticated;

-- ───────────────────────── refresh ─────────────────────────
-- Rebuilds [p_from, p_to] (inclusive Accra days). The advisory lock makes
-- overlapping cron runs queue instead of racing on the delete/insert.
CREATE OR REPLACE FUNCTION public.refresh_leaderboard_totals(p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'refresh_leaderboard_totals: invalid range % .. %', p_from, p_to;
  END IF;
  IF p_to - p_from > 92 THEN
    RAISE EXCEPTION 'refresh_leaderboard_totals: range over 93 days, refresh in chunks';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('leaderboard_refresh'));

  DELETE FROM public.leaderboard_daily_totals
   WHERE day BETWEEN p_from AND p_to;

  INSERT INTO public.leaderboard_daily_totals (board, day, user_id, total_amount, order_count, last_sale_at)
  SELECT e.board,
         (e.sold_at AT TIME ZONE 'Africa/Accra')::date,
         e.user_id,
         round(sum(e.amount), 2),
         count(*),
         max(e.sold_at)
    FROM public.leaderboard_sales_events e
   WHERE e.sold_at >= (p_from::timestamp AT TIME ZONE 'Africa/Accra')
     AND e.sold_at <  ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Accra')
     AND e.amount IS NOT NULL
   GROUP BY 1, 2, 3;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$$;

-- ───────────────────────── ranking ─────────────────────────
-- Shared ranking for a board and day range. Admins and excluded users never
-- rank. Ties: higher total, then more orders, then whoever got there first.
CREATE OR REPLACE FUNCTION public.leaderboard_ranked(p_board text, p_from date, p_to date)
RETURNS TABLE (rank bigint, user_id uuid, first_name text, last_name text,
               total_amount numeric, order_count bigint, last_sale_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH agg AS (
    SELECT t.user_id, sum(t.total_amount) AS total_amount,
           sum(t.order_count)::bigint AS order_count, max(t.last_sale_at) AS last_sale_at
      FROM public.leaderboard_daily_totals t
     WHERE t.board = p_board AND t.day BETWEEN p_from AND p_to
     GROUP BY t.user_id
  )
  SELECT row_number() OVER (ORDER BY a.total_amount DESC, a.order_count DESC, a.last_sale_at ASC, a.user_id),
         a.user_id, u.first_name::text, u.last_name::text,
         a.total_amount, a.order_count, a.last_sale_at
    FROM agg a
    JOIN public.users u ON u.id = a.user_id
   WHERE a.total_amount > 0
     AND COALESCE(u.role, '') <> 'admin'
     AND NOT EXISTS (SELECT 1 FROM public.leaderboard_exclusions x WHERE x.user_id = a.user_id);
$$;

CREATE OR REPLACE FUNCTION public.get_leaderboard(p_board text, p_from date, p_to date, p_limit integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH r AS (SELECT * FROM public.leaderboard_ranked(p_board, p_from, p_to))
  SELECT jsonb_build_object(
    'participants', (SELECT count(*) FROM r),
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'rank', r.rank, 'user_id', r.user_id,
               'first_name', r.first_name, 'last_name', r.last_name,
               'total', r.total_amount, 'orders', r.order_count) ORDER BY r.rank)
        FROM r WHERE r.rank <= LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100)
    ), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.get_leaderboard_rank(p_user_id uuid, p_board text, p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH r AS (SELECT * FROM public.leaderboard_ranked(p_board, p_from, p_to)),
       me AS (SELECT * FROM r WHERE r.user_id = p_user_id)
  SELECT jsonb_build_object(
    'participants', (SELECT count(*) FROM r),
    'rank',         (SELECT me.rank FROM me),
    'total',        COALESCE((SELECT me.total_amount FROM me), 0),
    'orders',       COALESCE((SELECT me.order_count FROM me), 0),
    'next_total',   (SELECT r.total_amount FROM r, me WHERE r.rank = me.rank - 1),
    'third_total',  (SELECT r.total_amount FROM r WHERE r.rank = 3)
  );
$$;

REVOKE ALL ON FUNCTION public.refresh_leaderboard_totals(date, date)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_ranked(text, date, date)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_leaderboard(text, date, date, integer)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_leaderboard_rank(uuid, text, date, date)             FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_leaderboard_totals(date, date)                TO service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_ranked(text, date, date)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_leaderboard(text, date, date, integer)            TO service_role;
GRANT EXECUTE ON FUNCTION public.get_leaderboard_rank(uuid, text, date, date)          TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT public.refresh_leaderboard_totals(current_date - 1, current_date);
--   SELECT public.get_leaderboard('dashboard', date_trunc('month', current_date)::date, current_date, 5);
--   SELECT count(*) FROM shop_orders WHERE is_stock_purchase;
