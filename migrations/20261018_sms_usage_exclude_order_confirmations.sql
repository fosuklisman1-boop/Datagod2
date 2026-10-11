-- Phase 4b: order confirmations do not count toward a shop's campaign usage caps.
--
-- Billed order confirmations are system messages (exempt from policy enforcement) but they are
-- logged in sms_send_logs with source = 'order_confirmation'. sms_account_usage feeds the hourly /
-- daily caps, so those logs must not consume the shop's own campaign allowance.
--
-- Identical to the definition in migrations/20261016_sms_scheduled_sends.sql (the latest, applied
-- live) except ONE added predicate: AND source <> 'order_confirmation'
-- (source is NOT NULL DEFAULT 'campaign', so no NULL handling is needed).
-- Controller: diff against pg_get_functiondef before applying.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION sms_account_usage(p_account_id UUID)
RETURNS TABLE(sends_last_hour INT, recipients_last_24h BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (count(*) FILTER (WHERE created_at >= now() - interval '1 hour'))::int,
    COALESCE(sum(recipients_count), 0)::bigint
  FROM sms_send_logs
  WHERE sms_account_id = p_account_id
    AND status <> 'blocked'
    AND source <> 'order_confirmation'
    AND NOT (
      status = 'failed'
      AND (
        COALESCE(policy_shadow->'review'->>'outcome', '') IN ('rejected', 'cancelled')
        OR credits_reserved = 0
      )
    )
    AND created_at >= now() - interval '24 hours';
$$;

REVOKE ALL ON FUNCTION sms_account_usage(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sms_account_usage(UUID) TO service_role;

COMMIT;
