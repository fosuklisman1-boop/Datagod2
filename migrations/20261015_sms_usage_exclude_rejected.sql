-- SMS send policy usage: stop counting sends that never went out toward the caps.
-- Same signature, return type, volatility, security and grants as
-- migrations/20261010_sms_account_usage_rpc.sql; only the WHERE clause changes. Excluded:
--   * status 'blocked' (as before);
--   * status 'failed' rejected by an admin (policy_shadow->'review'->>'outcome' = 'rejected');
--   * status 'failed' with credits_reserved = 0 (refunded/orphan logs, e.g. a failed enqueue).
-- COALESCE keeps rows whose policy_shadow is NULL (or has no review) from being excluded by NULL logic.
CREATE OR REPLACE FUNCTION sms_account_usage(p_account_id UUID)
RETURNS TABLE(sends_last_hour INT, recipients_last_24h BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (count(*) FILTER (WHERE created_at >= now() - interval '1 hour'))::int,
    COALESCE(sum(recipients_count), 0)::bigint
  FROM sms_send_logs
  WHERE sms_account_id = p_account_id
    AND status <> 'blocked'
    AND NOT (
      status = 'failed'
      AND (
        COALESCE(policy_shadow->'review'->>'outcome', '') = 'rejected'
        OR credits_reserved = 0
      )
    )
    AND created_at >= now() - interval '24 hours';
$$;

REVOKE ALL ON FUNCTION sms_account_usage(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sms_account_usage(UUID) TO service_role;
