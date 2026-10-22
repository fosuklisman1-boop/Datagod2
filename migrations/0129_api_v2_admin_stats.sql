-- 0129_api_v2_admin_stats.sql
--
-- Aggregate helpers for the Developer API v2 admin console. Functions only: no
-- table changes. Both read api_v2_keys / api_v2_logs (service_role only tables
-- from 0128) and return a single jsonb document so the route does one round
-- trip instead of paging rows into Node.
--
--   api_v2_admin_stats(p_since)         overview tiles
--   api_v2_key_activity(p_key, p_since) per-key "User Activity" panel
--   api_v2_key_request_counts(p_since)  per-key request counts for the key list
--
-- "ok" = status_code 200-399, "failed" = status_code >= 400. Requests rejected
-- with 401 carry no key id and are not logged in api_v2_logs, so they are not
-- counted here. avg_latency_ms is null when no row has a duration.
--
-- SECURITY DEFINER with a pinned search_path, and executable by service_role
-- only: the admin routes call these through the service client after
-- verifyAdminAccess, same posture as the 0128 tables.

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
    'last_used_at', (SELECT k.last_used_at FROM public.api_v2_keys k WHERE k.id = p_key)
  )
  FROM public.api_v2_logs
  WHERE key_id = p_key AND created_at >= p_since;
$$;

-- Request count per key since p_since, as {"<key_id>": n}. Rows without a key id
-- are skipped. Feeds the requests_24h column of the admin key list.
CREATE OR REPLACE FUNCTION public.api_v2_key_request_counts(p_since timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_object_agg(t.key_id::text, t.n), '{}'::jsonb)
  FROM (
    SELECT key_id, count(*) AS n
    FROM public.api_v2_logs
    WHERE created_at >= p_since AND key_id IS NOT NULL
    GROUP BY key_id
  ) t;
$$;

REVOKE ALL ON FUNCTION public.api_v2_key_request_counts(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_key_request_counts(timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.api_v2_admin_stats(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_v2_key_activity(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_admin_stats(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.api_v2_key_activity(uuid, timestamptz) TO service_role;
