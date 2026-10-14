-- 0124_lockdown_public_exposures.sql
-- Security audit 2026-10-14: four objects were reachable by ANYONE holding the public anon key
-- (confirmed by calling them as anon through PostgREST). Every legitimate caller uses the
-- service-role key (admin API routes, USSD/WhatsApp server code), so access is revoked from
-- PUBLIC/anon/authenticated and kept for service_role only. No data is deleted.

-- 1. Admin dashboard analytics: SECURITY DEFINER, no caller check -> leaked revenue, profit,
--    top agents and growth to anonymous callers.
REVOKE EXECUTE ON FUNCTION public.get_admin_dashboard_analytics()      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_admin_dashboard_analytics(text)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_admin_dashboard_hub_stats(text)  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_admin_dashboard_analytics()      TO service_role;
GRANT  EXECUTE ON FUNCTION public.get_admin_dashboard_analytics(text)  TO service_role;
GRANT  EXECUTE ON FUNCTION public.get_admin_dashboard_hub_stats(text)  TO service_role;

-- 2. "Has this phone ever bought?" -> customer enumeration by anyone.
REVOKE EXECUTE ON FUNCTION public.has_completed_purchase(text, text)   FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.has_completed_purchase(text, text)   TO service_role;

-- 3. Leftover AgentPortalGH debug table (Jul 2026): RLS was OFF and anon could SELECT full
--    request headers + bodies (customer phones, webhook signatures). Rows kept for now.
ALTER TABLE public.mtn_webhook_debug_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mtn_webhook_debug_log FROM anon, authenticated;

-- 4. ussd_whitelist: a policy named "service role only" was actually FOR ALL TO public USING (true).
--    service_role bypasses RLS, so with no policy only the server (admin API route) can use it.
DROP POLICY IF EXISTS "service role only" ON public.ussd_whitelist;
ALTER TABLE public.ussd_whitelist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ussd_whitelist FROM anon, authenticated;
