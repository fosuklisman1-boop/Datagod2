-- 0162_sub_agent_earnings_include_ussd.sql
--
-- Bug (reported 2026-11-12): a parent shop's "Earnings from Sub-Agents" card and its sub-agent profit history list
-- read public.shop_orders (web storefront) ONLY. Sales a sub-agent makes through its USSD shop code or WhatsApp bot
-- land in public.ussd_shop_orders. The parent IS paid for them (a shop_profits row is written, status credited), but
-- the card and the list never showed them: 1,661 paid orders / GHS 2,548.31 across 32 parent shops at the time.
--
-- Display-only. No money moves and no table changes:
--   1. get_sub_agent_earnings_stats(uuid): same JSON shape, now sums shop_orders + ussd_shop_orders.
--   2. get_sub_agent_profit_history(uuid, int, int): NEW. Paged, newest-first merge of both tables (paid orders with a
--      parent profit > 0), for /api/shop/sub-agent-profits. Paging two tables cannot be done correctly with two
--      separate PostgREST queries, hence a function.
--
-- shop_orders.created_at is `timestamp without time zone` holding UTC (the app writes ISO strings); it is read with
-- AT TIME ZONE 'UTC' so both sources sort and serialize as true instants.
--
-- Both functions are SECURITY DEFINER and take the parent shop id as an argument, so they are service_role ONLY
-- (the API routes resolve the caller's own shop first). CREATE OR REPLACE keeps the stats function's existing grants;
-- they are restated anyway so this file is self-contained. Idempotent.

BEGIN;

-- Was LANGUAGE plpgsql scanning the orders twice; now one pass in plain SQL (same arguments, same json result).
-- Order count is every paid order (profit 0 included), exactly as before; the history list shows only profit > 0.
CREATE OR REPLACE FUNCTION public.get_sub_agent_earnings_stats(p_parent_shop_id uuid)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  -- Same row filter as before for each table: orders by a current sub-agent of this parent, or tagged to it.
  WITH o AS (
    SELECT so.shop_id, so.total_price AS sale, so.parent_profit_amount AS profit
      FROM public.shop_orders so
     WHERE (so.shop_id IN (SELECT s.id FROM public.user_shops s WHERE s.parent_shop_id = p_parent_shop_id)
            OR so.parent_shop_id = p_parent_shop_id)
       AND so.payment_status = 'completed'
    UNION ALL
    SELECT uo.shop_id, uo.amount, uo.parent_profit_amount
      FROM public.ussd_shop_orders uo
     WHERE (uo.shop_id IN (SELECT s.id FROM public.user_shops s WHERE s.parent_shop_id = p_parent_shop_id)
            OR uo.parent_shop_id = p_parent_shop_id)
       AND uo.payment_status = 'completed'
  ),
  g AS (
    SELECT o.shop_id,
           COUNT(*)                    AS total_orders,
           COALESCE(SUM(o.sale), 0)    AS total_sales,
           COALESCE(SUM(o.profit), 0)  AS your_earnings
      FROM o
     GROUP BY o.shop_id
  )
  SELECT json_build_object(
    'totalEarnings', COALESCE((SELECT SUM(g.your_earnings) FROM g), 0),
    'totalOrders',   COALESCE((SELECT SUM(g.total_orders) FROM g), 0)::bigint,
    'breakdown',     COALESCE((SELECT json_agg(g) FROM g), '[]'::json)
  );
$fn$;

CREATE OR REPLACE FUNCTION public.get_sub_agent_profit_history(p_parent_shop_id uuid, p_limit integer, p_offset integer)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH o AS (
    SELECT so.id, so.shop_id, so.reference_code::text AS reference_code, so.network::text AS network,
           so.volume_gb AS volume_gb, so.total_price AS total_price, so.parent_profit_amount AS profit_amount,
           (so.created_at AT TIME ZONE 'UTC') AS created_at, 'web'::text AS source
      FROM public.shop_orders so
     WHERE so.parent_shop_id = p_parent_shop_id
       AND so.payment_status = 'completed'
       AND so.parent_profit_amount > 0
    UNION ALL
    SELECT uo.id, uo.shop_id, uo.paystack_reference::text, uo.network::text,
           -- All 2,221 prod values were plain numbers ("1".."8") on 2026-11-12; the original DDL documents '2GB', so
           -- a trailing GB is accepted too. Anything else is NULL (shown blank), never a cast error.
           CASE WHEN btrim(uo.package_size) ~* '^[0-9]+(\.[0-9]+)?\s*(gb)?$'
                THEN substring(btrim(uo.package_size) FROM '^[0-9]+(?:\.[0-9]+)?')::numeric END,
           uo.amount, uo.parent_profit_amount, uo.created_at, 'ussd'::text
      FROM public.ussd_shop_orders uo
     WHERE uo.parent_shop_id = p_parent_shop_id
       AND uo.payment_status = 'completed'
       AND uo.parent_profit_amount > 0
  ),
  page AS (
    SELECT o.* FROM o
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT json_build_object(
    'total',   (SELECT COUNT(*) FROM o),
    'records', COALESCE((SELECT json_agg(page ORDER BY page.created_at DESC, page.id DESC) FROM page), '[]'::json)
  );
$fn$;

REVOKE ALL ON FUNCTION public.get_sub_agent_earnings_stats(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sub_agent_earnings_stats(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_sub_agent_profit_history(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sub_agent_profit_history(uuid, integer, integer) TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT grantee FROM information_schema.routine_privileges
--    WHERE routine_name IN ('get_sub_agent_earnings_stats','get_sub_agent_profit_history');  -- postgres, service_role
--   SELECT public.get_sub_agent_profit_history('<parent shop id>', 5, 0);
