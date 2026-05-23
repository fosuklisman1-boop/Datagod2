-- =============================================
-- Fix Supabase Function Security Linter Issues
-- 1. Pin search_path on all flagged functions
-- 2. Revoke anon EXECUTE on SECURITY DEFINER functions
-- 3. Tighten always-true RLS policies
-- =============================================

-- =============================================
-- PART 1: Fix Mutable search_path (23 functions)
-- Without SET search_path, a forged schema earlier in the
-- path could shadow public tables inside SECURITY DEFINER
-- functions running with elevated privileges.
-- =============================================

-- Wallet / financial functions
ALTER FUNCTION public.deduct_wallet(uuid, numeric)                              SET search_path = public;
ALTER FUNCTION public.credit_wallet_safely(uuid, numeric, text, text, text)     SET search_path = public;
ALTER FUNCTION public.place_api_order(uuid, uuid, uuid, text, numeric, numeric, text, text, text) SET search_path = public;

-- Balance sync functions
ALTER FUNCTION public.sync_shop_balance(uuid)                                   SET search_path = public;
ALTER FUNCTION public.trg_sync_shop_balance()                                   SET search_path = public;
ALTER FUNCTION public.get_shop_balance_breakdown(uuid)                          SET search_path = public;

-- Admin stats RPCs
ALTER FUNCTION public.get_admin_dashboard_stats()                               SET search_path = public;
ALTER FUNCTION public.get_admin_dashboard_stats_v2()                            SET search_path = public;
ALTER FUNCTION public.get_order_history_stats(timestamptz, timestamptz, text)   SET search_path = public;
ALTER FUNCTION public.get_profits_history_stats(uuid, text, timestamptz, timestamptz) SET search_path = public;
ALTER FUNCTION public.get_sub_agent_earnings_stats(uuid)                        SET search_path = public;
ALTER FUNCTION public.get_user_financial_summary(uuid)                          SET search_path = public;

-- Subscription / dealer functions
ALTER FUNCTION public.check_expired_subscriptions()                             SET search_path = public;

-- USSD functions
ALTER FUNCTION public.deduct_ussd_shop_token(uuid)                              SET search_path = public;
ALTER FUNCTION public.auto_assign_ussd_shop_code()                              SET search_path = public;

-- Results checker functions
ALTER FUNCTION public.assign_results_checker_vouchers(text, integer, uuid)      SET search_path = public;
ALTER FUNCTION public.finalize_results_checker_sale(uuid, uuid)                 SET search_path = public;
ALTER FUNCTION public.release_expired_results_checker_reservations()            SET search_path = public;

-- Push notification trigger
ALTER FUNCTION public.update_push_subscriptions_timestamp()                     SET search_path = public;

-- Functions not found in repo migrations — fix dynamically from pg_proc
-- (get_available_balance, ensure_shop_balance_exists, get_locked_balance, recalibrate_shop_balances)
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS proc_sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_available_balance',
        'ensure_shop_balance_exists',
        'get_locked_balance',
        'recalibrate_shop_balances'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', fn.proc_sig);
  END LOOP;
END $$;

-- =============================================
-- PART 2: Revoke anon EXECUTE on SECURITY DEFINER functions
-- These functions run as superuser — allowing unauthenticated
-- callers to invoke them via /rest/v1/rpc is a critical risk:
-- credit_wallet_safely and deduct_wallet can manipulate any
-- user's wallet balance without authentication.
-- =============================================

REVOKE EXECUTE ON FUNCTION public.credit_wallet_safely(uuid, numeric, text, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.deduct_wallet(uuid, numeric)                          FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_expired_subscriptions()                         FROM anon;
REVOKE EXECUTE ON FUNCTION public.deduct_ussd_shop_token(uuid)                          FROM anon;
REVOKE EXECUTE ON FUNCTION public.auto_assign_ussd_shop_code()                          FROM anon;

-- =============================================
-- PART 3: Fix always-true RLS policies
--
-- "Service role full access" policies on broadcast_logs,
-- email_logs, push_subscriptions are redundant: service_role
-- bypasses RLS automatically. But USING(true) WITH CHECK(true)
-- for ALL operations means any authenticated user can also
-- INSERT/UPDATE/DELETE — which was not intentional.
-- Dropping them leaves the existing user-scoped SELECT
-- policies intact while service_role continues to bypass.
-- =============================================

-- email_logs: drop the always-true ALL policy.
-- The existing "Users can view their own email logs" SELECT policy is retained.
DROP POLICY IF EXISTS "Service role full access on email_logs" ON public.email_logs;

-- broadcast_logs: drop the always-true ALL policy.
-- The existing "Admins can view broadcast logs" SELECT policy is retained.
DROP POLICY IF EXISTS "Service role full access on broadcast_logs" ON public.broadcast_logs;

-- push_subscriptions: drop the always-true ALL policy.
-- push/subscribe and push/unsubscribe routes use supabaseAdmin (service_role).
DROP POLICY IF EXISTS "Service role manages push subscriptions" ON public.push_subscriptions;

-- shop_orders: drop the always-true INSERT policy entirely.
-- The create route sets order_status to 'pending' OR 'blacklisted' (for
-- blacklisted phones), so any status-based WITH CHECK would be incomplete.
-- More importantly, all actual inserts go through service_role API routes
-- which bypass RLS — no authenticated-role INSERT path exists in the app.
DROP POLICY IF EXISTS "Authenticated users can create shop orders" ON public.shop_orders;
DROP POLICY IF EXISTS "Anyone can create shop orders" ON public.shop_orders;
