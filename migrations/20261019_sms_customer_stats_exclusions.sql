-- Phase 4: SMS Home "last 30 days" stats ignore order confirmations and cancelled scheduled sends.
--
-- Identical to migrations/20261012_sms_customer_reads.sql (the only definition) except two added
-- predicates:
--   AND source <> 'order_confirmation'   (source is NOT NULL DEFAULT 'campaign', migration 20261016)
--   AND NOT (status = 'failed' AND COALESCE(policy_shadow->'review'->>'outcome','') = 'cancelled')
-- The blocked/scheduled exclusion is kept. Still SECURITY INVOKER (no SECURITY DEFINER), service-role
-- only, exactly as before. Controller: diff against pg_get_functiondef before applying.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION sms_customer_stats(p_account_id uuid, p_days int DEFAULT 30)
RETURNS TABLE(campaigns bigint, recipients bigint, credits_used bigint)
LANGUAGE sql STABLE AS $$
  SELECT count(*)::bigint,
         COALESCE(sum(recipients_count),0)::bigint,
         COALESCE(sum(credits_used),0)::bigint
    FROM sms_send_logs
   WHERE sms_account_id = p_account_id
     AND created_at >= now() - make_interval(days => GREATEST(p_days,1))
     AND status NOT IN ('blocked','scheduled')
     AND source <> 'order_confirmation'
     AND NOT (status = 'failed' AND COALESCE(policy_shadow->'review'->>'outcome','') = 'cancelled');
$$;

REVOKE ALL ON FUNCTION sms_customer_stats(uuid,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sms_customer_stats(uuid,int) TO service_role;

COMMIT;
