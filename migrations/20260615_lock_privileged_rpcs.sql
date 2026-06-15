-- 20260615_lock_privileged_rpcs.sql
--
-- SECURITY FIX (CRITICAL) — privileged SECURITY DEFINER RPCs callable by anon/authenticated.
--
-- ROOT CAUSE
-- PostgreSQL grants EXECUTE to PUBLIC by default at function creation, and PUBLIC
-- is inherited by anon + authenticated. migrations/20260523_fix_function_security_issues.sql
-- tried to lock these down but only did `REVOKE ... FROM anon` for a few — it never
-- revoked the PUBLIC grant, and PG has no negative grants, so anon AND authenticated
-- retained EXECUTE. place_api_order was never revoked at all. Verified LIVE
-- (has_function_privilege): anon_exec=true, authenticated_exec=true for all below.
--
-- IMPACT (each callable via the public anon key + any/no JWT at /rest/v1/rpc/<fn>):
--   * credit_wallet_safely(p_user_id, p_amount, ...) — NO caller auth check; credits
--     ANY wallet ANY amount with an attacker-chosen idempotency reference =>
--     UNLIMITED money fabrication, then spendable on data/airtime/withdrawals. CRITICAL.
--   * deduct_wallet(p_user_id, p_amount) — drains/sabotages any wallet. HIGH.
--   * place_api_order(..., p_price, ...) — deducts any wallet + injects orders at an
--     attacker-chosen price (p_price=0 => free data bundles). HIGH.
--   * update_wallet_balance / credit_wallet / debit_wallet — arbitrary balance writes.
--   * assign_results_checker_vouchers / finalize_results_checker_sale — assign voucher
--     PINs / finalize sales without paying.
--   * deduct_ussd_shop_token, auto_assign_ussd_shop_code, balance/broadcast/subscription
--     maintenance fns — privileged state mutation.
--
-- WHY SAFE
-- Every legitimate caller is a SERVICE-ROLE server path (webhooks, order/airtime/RC/
-- USSD routes, fulfillment libs, cron). service_role bypasses these grants entirely,
-- so it keeps EXECUTE. The only non-service-role caller is shop-service
-- createProfitRecord's best-effort debt-recovery, which is error-handled (non-fatal)
-- and already RLS-inert as anon. update_wallet_balance has zero callers (dead).
--
-- NOTE: get_current_user_role() is deliberately NOT revoked — it is referenced by the
-- users UPDATE RLS policy (migration 0045) and must remain EXECUTE-able by authenticated.

BEGIN;

DO $$
DECLARE
  fn text;
  sigs text[] := ARRAY[
    'public.credit_wallet_safely(uuid, numeric, text, text, text)',
    'public.deduct_wallet(uuid, numeric)',
    'public.credit_wallet(uuid, numeric)',
    'public.debit_wallet(uuid, numeric)',
    'public.update_wallet_balance(uuid, numeric)',
    'public.place_api_order(uuid, uuid, uuid, text, numeric, numeric, text, text, text)',
    'public.assign_results_checker_vouchers(text, integer, uuid)',
    'public.finalize_results_checker_sale(uuid, uuid)',
    'public.deduct_ussd_shop_token(uuid)',
    'public.recalibrate_shop_balances()',
    'public.sync_shop_balance(uuid)',
    'public.ensure_shop_balance_exists(uuid)',
    'public.check_expired_subscriptions()',
    'public.release_expired_results_checker_reservations()',
    'public.claim_broadcast_recipients(uuid, integer, integer)',
    'public.recompute_broadcast_results(uuid, integer)'
  ];
BEGIN
  FOREACH fn IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

COMMIT;

-- VERIFY (every row must show anon_exec=false, authed_exec=false, service_exec=true):
--   SELECT p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_exec,
--          has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_exec
--     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public'
--      AND p.proname IN ('credit_wallet_safely','deduct_wallet','place_api_order',
--                        'update_wallet_balance','assign_results_checker_vouchers',
--                        'finalize_results_checker_sale','deduct_ussd_shop_token')
--    ORDER BY p.proname;
