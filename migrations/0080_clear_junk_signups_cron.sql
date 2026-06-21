-- 0080_clear_junk_signups_cron.sql
--
-- Recurring junk-signup sweep (complements the 0079 disposable-email block).
--
-- Deletes UNCONFIRMED auth.users older than 24h that have NO orders, NO api
-- orders, and NO funded wallet — i.e. abandoned / bot signups. Safe because:
--  - email confirmation is ON, so real users confirm within minutes; an account
--    still unconfirmed after 24h is abandoned (and can re-sign-up freely).
--  - the activity guards never delete anyone who actually transacted.
-- Deletes children first (wallets, public.users) then auth.users.
-- SECURITY DEFINER + EXECUTE revoked from app roles (cron/service-role only),
-- per the RPC-exposure lesson in 0068 / the RLS audit.
--
-- Scheduled hourly via pg_cron. Applied live via the Management API 2026-06-21.

CREATE OR REPLACE FUNCTION public.clear_junk_signups()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  n integer;
  ids uuid[];
BEGIN
  SELECT array_agg(au.id) INTO ids
  FROM auth.users au
  WHERE au.email_confirmed_at IS NULL
    AND au.created_at < now() - interval '24 hours'
    AND NOT EXISTS (SELECT 1 FROM orders o     WHERE o.user_id = au.id)
    AND NOT EXISTS (SELECT 1 FROM api_orders a WHERE a.user_id = au.id)
    AND NOT EXISTS (SELECT 1 FROM wallets w    WHERE w.user_id = au.id AND w.balance > 0);

  IF ids IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM wallets       WHERE user_id = ANY(ids);
  DELETE FROM public.users  WHERE id = ANY(ids);
  DELETE FROM auth.users    WHERE id = ANY(ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.clear_junk_signups() FROM public, anon, authenticated;

-- Hourly schedule (cron.schedule upserts by job name, so re-running is safe).
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('clear-junk-signups', '27 * * * *', $$SELECT public.clear_junk_signups();$$);
