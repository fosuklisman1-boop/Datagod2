-- 20260615_fix_withdrawal_insert_balance_inflation.sql
--
-- SECURITY FIX (HIGH) — withdrawable-balance inflation / theft via direct insert.
--
-- ROOT CAUSE
-- withdrawal_requests has an INSERT policy "Users can create withdrawal requests"
-- scoped to {public}/authenticated whose WITH CHECK is ONLY (user_id = auth.uid()).
-- It does NOT constrain shop_id, amount, or status, and the table has NO CHECK
-- constraint on amount. Combined with 0060's blanket grant (authenticated has
-- INSERT on all tables), any logged-in user can insert arbitrary rows via the
-- public PostgREST endpoint with their JWT.
--
-- The cached/available balance is computed by get_shop_balance_breakdown() as:
--     available = credited_profit - SUM(amount WHERE status IN ('approved','completed'))
-- so an attacker can insert a fake row { user_id: self, shop_id: <own shop>,
-- status: 'completed', amount: -100000 } which REDUCES the withdrawn total and
-- thereby INFLATES their available balance (an AFTER trigger,
-- after_withdrawal_requests_change, immediately resyncs shop_available_balance).
-- They then request a normal withdrawal up to the inflated balance; the admin
-- approval path re-checks against the SAME poisoned function and pays out real
-- money via Moolre.
--
-- WHY THE FIX IS SAFE
-- Legitimate withdrawal creation does NOT use this policy: it goes through the
-- service-role endpoint /api/user/withdrawals/create (-> withdrawalService.
-- createWithdrawalRequest with the service-role client), which bypasses RLS and
-- validates shop ownership, fee, and balance. So removing the authenticated
-- INSERT policy breaks nothing. We also add data-layer guards and harden the
-- balance function as defense in depth.

BEGIN;

-- 1) Remove the over-permissive client INSERT path. Legit inserts are service-role.
DROP POLICY IF EXISTS "Users can create withdrawal requests" ON withdrawal_requests;

-- Optional explicit backend policy (service_role bypasses RLS anyway; kept for clarity).
DROP POLICY IF EXISTS "Service role can insert withdrawal_requests" ON withdrawal_requests;
CREATE POLICY "Service role can insert withdrawal_requests"
  ON withdrawal_requests FOR INSERT
  TO service_role
  WITH CHECK (true);

-- 2) Data-layer guard: amount must be positive. NOT VALID skips re-checking any
--    pre-existing rows but STILL enforces on every new insert/update.
ALTER TABLE withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_amount_positive;
ALTER TABLE withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_amount_positive CHECK (amount > 0) NOT VALID;

-- 3) Harden the balance function: never let a non-positive withdrawal amount
--    affect the withdrawn total, even if a bad row exists. Definition preserved
--    verbatim except the `AND amount > 0` guard on the total_w subquery.
CREATE OR REPLACE FUNCTION public.get_shop_balance_breakdown(p_shop_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_result JSON;
BEGIN
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

-- POST-APPLY:
--  - As a normal authenticated user, an INSERT into withdrawal_requests via the
--    anon endpoint must now be DENIED (no permissive policy).
--  - A legit withdrawal via the app (POST /api/user/withdrawals/create) must still work.
--  - Audit any existing rows with amount <= 0:
--      SELECT id, shop_id, user_id, amount, status FROM withdrawal_requests WHERE amount <= 0;
--    Investigate/clean them, then optionally: ALTER TABLE withdrawal_requests
--    VALIDATE CONSTRAINT withdrawal_requests_amount_positive;
