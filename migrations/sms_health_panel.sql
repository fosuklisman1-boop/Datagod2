-- SMS health panel support: a provider column + a one-call aggregation function.

ALTER TABLE sms_logs
  ADD COLUMN IF NOT EXISTS provider VARCHAR(20);

-- Returns overall counts, per-type, per-provider, and recent failures for the
-- last p_hours, in a single JSON payload. Used by /api/admin/sms-health.
CREATE OR REPLACE FUNCTION sms_health(p_hours int DEFAULT 24)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH win AS (
    SELECT * FROM sms_logs
    WHERE created_at > now() - make_interval(hours => p_hours)
  )
  SELECT jsonb_build_object(
    'window_hours', p_hours,
    'overall', (SELECT jsonb_build_object(
        'total',     count(*),
        'delivered', count(*) FILTER (WHERE status = 'delivered'),
        'failed',    count(*) FILTER (WHERE status = 'failed'),
        'sent',      count(*) FILTER (WHERE status = 'sent'),
        'pending',   count(*) FILTER (WHERE status = 'pending')
      ) FROM win),
    'by_type', (SELECT coalesce(jsonb_agg(t ORDER BY t.total DESC), '[]'::jsonb) FROM (
        SELECT coalesce(message_type, 'unknown') AS type,
               count(*)                               AS total,
               count(*) FILTER (WHERE status='delivered') AS delivered,
               count(*) FILTER (WHERE status='failed')    AS failed,
               count(*) FILTER (WHERE status='sent')      AS sent
        FROM win GROUP BY message_type
      ) t),
    'by_provider', (SELECT coalesce(jsonb_agg(p ORDER BY p.total DESC), '[]'::jsonb) FROM (
        SELECT coalesce(provider, 'unknown') AS provider,
               count(*)                               AS total,
               count(*) FILTER (WHERE status='delivered') AS delivered,
               count(*) FILTER (WHERE status='failed')    AS failed
        FROM win GROUP BY provider
      ) p),
    'recent_failures', (SELECT coalesce(jsonb_agg(f ORDER BY f.created_at DESC), '[]'::jsonb) FROM (
        SELECT phone_number, message_type, error_message, created_at
        FROM win WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20
      ) f)
  );
$$;

GRANT EXECUTE ON FUNCTION sms_health(int) TO service_role;
