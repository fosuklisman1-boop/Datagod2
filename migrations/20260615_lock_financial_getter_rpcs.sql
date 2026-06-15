-- 20260615_lock_financial_getter_rpcs.sql
--
-- SECURITY FIX (MEDIUM) — financial getter RPCs leak cross-user/cross-shop data.
--
-- Follow-up to 20260615_lock_privileged_rpcs.sql. These SECURITY DEFINER getters
-- bypass RLS and were EXECUTE-able by anon/authenticated. Most take a user_id or
-- shop_id and return that entity's financials, so any logged-in user could read
-- arbitrary users'/shops' balances and platform-wide admin stats. shop UUIDs are
-- discoverable (user_shops has an is_active=true read policy), so the cross-shop
-- read is practically reachable, not just UUID-guessing.
--
-- Two groups:
--  (A) Server-only (called only from service-role admin/stats routes) OR dead
--      (no callers): REVOKE from anon/authenticated/PUBLIC, keep service_role.
--  (B) get_shop_balance_breakdown is ALSO called client-side (mobile app +
--      browser shop-service for the owner's own dashboard), so it must stay
--      authenticated-executable — instead, add an in-function ownership guard so
--      a caller can only read their OWN shop (service_role bypasses the guard).

BEGIN;

-- (A) Lock server-only / dead getters --------------------------------------------------
DO $$
DECLARE
  fn text;
  sigs text[] := ARRAY[
    'public.get_admin_dashboard_stats()',
    'public.get_admin_dashboard_stats_v2()',
    'public.get_user_financial_summary(uuid)',
    'public.get_order_history_stats(timestamp with time zone, timestamp with time zone, text)',
    'public.get_profits_history_stats(uuid, text, timestamp with time zone, timestamp with time zone)',
    'public.get_sub_agent_earnings_stats(uuid)',
    'public.get_available_balance(uuid)',
    'public.get_locked_balance(uuid)',
    'public.get_wallet_balance(uuid)',
    'public.get_shop_available_balance(uuid)',
    'public.get_shop_total_profit(uuid)',
    'public.get_payment_verification_status(uuid)',
    'public.is_payment_stuck(uuid, integer)',
    'public.get_stuck_payments(integer)'
  ];
BEGIN
  FOREACH fn IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- (B) get_shop_balance_breakdown: keep authenticated EXECUTE, add ownership guard.
--     Body preserved from 20260615_fix_withdrawal_insert_balance_inflation.sql
--     (amount > 0 guard) plus the new authorization check.
CREATE OR REPLACE FUNCTION public.get_shop_balance_breakdown(p_shop_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_result JSON;
BEGIN
    -- Authorization: backend (service_role) bypasses; otherwise the caller must
    -- own p_shop_id. Blocks an authenticated user from reading other shops'
    -- financials by passing a discovered shop UUID.
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND NOT EXISTS (
         SELECT 1 FROM user_shops WHERE id = p_shop_id AND user_id = auth.uid()
       )
    THEN
        RAISE EXCEPTION 'not authorized for shop %', p_shop_id USING ERRCODE = '42501';
    END IF;

    SELECT json_build_object(
        'total_p', COALESCE(SUM(profit_amount), 0),
        'credited_p', COALESCE(SUM(CASE WHEN status = 'credited' THEN profit_amount ELSE 0 END), 0),
        'withdrawn_p', COALESCE(SUM(CASE WHEN status = 'withdrawn' THEN profit_amount ELSE 0 END), 0),
        'total_w', (
            SELECT COALESCE(SUM(amount), 0)
            FROM withdrawal_requests
            WHERE shop_id = p_shop_id
              AND status IN ('approved', 'completed')
              AND amount > 0
        )
    ) INTO v_result
    FROM shop_profits
    WHERE shop_id = p_shop_id;

    RETURN v_result;
END;
$function$;

COMMIT;
