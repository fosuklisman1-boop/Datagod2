-- SMS send policy: exact per-account usage in one round trip (PostgREST row caps would
-- truncate a client-side sum). Blocked sends don't count. Spec §5.3 caps.
CREATE OR REPLACE FUNCTION sms_account_usage(p_account_id UUID)
RETURNS TABLE(sends_last_hour INT, recipients_last_24h BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (count(*) FILTER (WHERE created_at >= now() - interval '1 hour'))::int,
    COALESCE(sum(recipients_count), 0)::bigint
  FROM sms_send_logs
  WHERE sms_account_id = p_account_id
    AND status <> 'blocked'
    AND created_at >= now() - interval '24 hours';
$$;

REVOKE ALL ON FUNCTION sms_account_usage(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sms_account_usage(UUID) TO service_role;
