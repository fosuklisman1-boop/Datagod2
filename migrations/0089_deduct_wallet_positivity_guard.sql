-- 0089_deduct_wallet_positivity_guard.sql
--
-- Bypass-audit finding (2026-06-22): /api/afa/submit trusted a client-supplied
-- `amount` and fed it to the service-role deduct_wallet RPC. A NEGATIVE amount
-- made `balance = balance - (-X) = balance + X` with the guard `balance >= -X`
-- always true → MINTED real, spendable/withdrawable wallet balance.
--
-- Systemic fix: reject non-positive amounts INSIDE deduct_wallet, so NO caller
-- (current or future, on any channel) can mint via a negative amount. Rewritten
-- from LANGUAGE sql to plpgsql to allow RAISE; return shape + insufficient-balance
-- behaviour (zero rows) are unchanged, so all callers work as before. The
-- service_role-only EXECUTE grant is preserved by CREATE OR REPLACE.
-- (No CHECK (balance >= 0) constraint: 23 wallets already carry small negative
-- balances from pre-existing race artifacts, which such a constraint would break.)
-- Applied live via the Management API 2026-06-22.

CREATE OR REPLACE FUNCTION public.deduct_wallet(p_user_id uuid, p_amount numeric)
RETURNS TABLE(new_balance numeric, old_balance numeric, new_total_spent numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $f$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'deduct_wallet: amount must be positive (got %)', p_amount;
  END IF;
  RETURN QUERY
    UPDATE wallets
    SET balance = balance - p_amount,
        total_spent = COALESCE(total_spent, 0) + p_amount,
        updated_at = now()
    WHERE user_id = p_user_id
      AND balance >= p_amount
    RETURNING balance AS new_balance, (balance + p_amount) AS old_balance, total_spent AS new_total_spent;
END;
$f$;
