-- 0131_api_v2_stats_orders.sql
--
-- Order attribution for the Developer API v2 admin console. Replaces the two
-- stats functions from 0129 (same signatures, every existing field kept) and
-- adds revenue / order counts read from api_orders.api_v2_key_id (0130).
--
--   api_v2_admin_stats(p_since)         + revenue, revenue_lifetime, orders, pending_orders
--   api_v2_key_activity(p_key, p_since) + spent, orders, pending
--
-- Only orders attributed to a v2 key (api_v2_key_id IS NOT NULL) are counted;
-- v1 orders (api_key_id) never appear here. Money counts orders that have not
-- failed or been refunded: status NOT IN ('failed','refunded'). "pending" =
-- status IN ('pending','processing','held_registration'). Time-filtered values
-- use created_at >= p_since; revenue_lifetime has no time filter. Every new
-- numeric field COALESCEs to 0 when there are no rows.
--
-- The TypeScript shapers treat a missing field as "not available" (tile
-- hidden), so the app keeps working before and after this is applied.
--
-- SECURITY DEFINER with a pinned search_path, schema-qualified tables,
-- executable by service_role only (grants re-asserted below, as in 0129).
-- Functions only, no table changes. NOT YET APPLIED: follows the prod change
-- protocol (dry run via 0131_api_v2_stats_orders.selftest.sql first).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.api_v2_admin_stats(p_since timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'keys', (
      SELECT jsonb_build_object(
        'total',   count(*),
        'pending', count(*) FILTER (WHERE status = 'pending'),
        'active',  count(*) FILTER (WHERE status = 'active'),
        'revoked', count(*) FILTER (WHERE status = 'revoked')
      )
      FROM public.api_v2_keys
    ),
    'requests', (SELECT count(*) FROM public.api_v2_logs WHERE created_at >= p_since),
    'ok', (
      SELECT count(*) FROM public.api_v2_logs
      WHERE created_at >= p_since AND status_code BETWEEN 200 AND 399
    ),
    'failed', (
      SELECT count(*) FROM public.api_v2_logs
      WHERE created_at >= p_since AND status_code >= 400
    ),
    'avg_latency_ms', (
      SELECT avg(duration_ms)::float8 FROM public.api_v2_logs
      WHERE created_at >= p_since AND duration_ms IS NOT NULL
    ),
    'top', (
      SELECT jsonb_build_object('user_id', t.user_id, 'requests', t.n)
      FROM (
        SELECT user_id, count(*) AS n
        FROM public.api_v2_logs
        WHERE created_at >= p_since AND user_id IS NOT NULL
        GROUP BY user_id
        ORDER BY n DESC, user_id
        LIMIT 1
      ) t
    ),
    'revenue', (
      SELECT COALESCE(sum(o.price), 0)::float8
      FROM public.api_orders o
      WHERE o.api_v2_key_id IS NOT NULL
        AND o.created_at >= p_since
        AND o.status NOT IN ('failed', 'refunded')
    ),
    'revenue_lifetime', (
      SELECT COALESCE(sum(o.price), 0)::float8
      FROM public.api_orders o
      WHERE o.api_v2_key_id IS NOT NULL
        AND o.status NOT IN ('failed', 'refunded')
    ),
    'orders', (
      SELECT count(*)
      FROM public.api_orders o
      WHERE o.api_v2_key_id IS NOT NULL
        AND o.created_at >= p_since
        AND o.status NOT IN ('failed', 'refunded')
    ),
    'pending_orders', (
      SELECT count(*)
      FROM public.api_orders o
      WHERE o.api_v2_key_id IS NOT NULL
        AND o.created_at >= p_since
        AND o.status IN ('pending', 'processing', 'held_registration')
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.api_v2_key_activity(p_key uuid, p_since timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'requests', count(*),
    'ok',       count(*) FILTER (WHERE status_code BETWEEN 200 AND 399),
    'failed',   count(*) FILTER (WHERE status_code >= 400),
    'avg_latency_ms', avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL)::float8,
    'last_used_at', (SELECT k.last_used_at FROM public.api_v2_keys k WHERE k.id = p_key),
    'spent', (
      SELECT COALESCE(sum(o.price), 0)::float8
      FROM public.api_orders o
      WHERE o.api_v2_key_id = p_key
        AND o.created_at >= p_since
        AND o.status NOT IN ('failed', 'refunded')
    ),
    'orders', (
      SELECT count(*)
      FROM public.api_orders o
      WHERE o.api_v2_key_id = p_key
        AND o.created_at >= p_since
        AND o.status NOT IN ('failed', 'refunded')
    ),
    'pending', (
      SELECT count(*)
      FROM public.api_orders o
      WHERE o.api_v2_key_id = p_key
        AND o.created_at >= p_since
        AND o.status IN ('pending', 'processing', 'held_registration')
    )
  )
  FROM public.api_v2_logs
  WHERE key_id = p_key AND created_at >= p_since;
$$;

REVOKE ALL ON FUNCTION public.api_v2_admin_stats(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_v2_key_activity(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_admin_stats(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.api_v2_key_activity(uuid, timestamptz) TO service_role;

COMMIT;
