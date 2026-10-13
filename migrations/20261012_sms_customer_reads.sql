-- Phase 3 customer read model: 30-day account stats for the SMS Home page.
BEGIN;

CREATE OR REPLACE FUNCTION sms_customer_stats(p_account_id uuid, p_days int DEFAULT 30)
RETURNS TABLE(campaigns bigint, recipients bigint, credits_used bigint)
LANGUAGE sql STABLE AS $$
  SELECT count(*)::bigint,
         COALESCE(sum(recipients_count),0)::bigint,
         COALESCE(sum(credits_used),0)::bigint
    FROM sms_send_logs
   WHERE sms_account_id = p_account_id
     AND created_at >= now() - make_interval(days => GREATEST(p_days,1))
     AND status NOT IN ('blocked','scheduled');
$$;

REVOKE ALL ON FUNCTION sms_customer_stats(uuid,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sms_customer_stats(uuid,int) TO service_role;

COMMIT;
