-- migrations/0066_sms_activation_atomic.sql
-- Hardens the activation + welcome-bonus RPCs after adversarial review of 0065:
--  1. activate_sms_account: debit the wallet INSIDE the RPC (atomic with the status flip),
--     and make the status transition itself the concurrency guard (WHERE status='inactive'),
--     so two concurrent activations cannot double-charge and no separate refund path is needed.
--  2. claim_sms_welcome_bonus: enforce status='active' inside the RPC, and RAISE on a
--     'duplicate' credit outcome so a phantom (zero-unit) claim can never be reported as success.
--  3. Lock both RPCs to service_role (REVOKE from PUBLIC, anon, authenticated explicitly).

-- ── activate_sms_account (atomic debit-inside) ─────────────────────────────
CREATE OR REPLACE FUNCTION activate_sms_account(
  p_account_id UUID,
  p_paid_from  TEXT
)
RETURNS TABLE(ok BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fee    NUMERIC(10,2);
  v_user   UUID;
  v_status TEXT;
BEGIN
  SELECT (value->>'amount')::NUMERIC INTO v_fee
  FROM tenant_global_settings WHERE key = 'sms_activation_fee';
  IF v_fee IS NULL THEN
    RAISE EXCEPTION 'sms_activation_fee not configured' USING ERRCODE = 'P0002';
  END IF;

  -- Atomic activation guard: only an 'inactive' row flips to active. Under concurrency the
  -- row lock means exactly ONE caller wins; the loser sees 0 rows -> raises below (no debit).
  UPDATE sms_accounts
  SET status = 'active', activated_at = now(), amount_paid = v_fee,
      paid_from = p_paid_from, updated_at = now()
  WHERE id = p_account_id AND status = 'inactive'
  RETURNING user_id INTO v_user;

  IF v_user IS NULL THEN
    SELECT status INTO v_status FROM sms_accounts WHERE id = p_account_id;
    IF v_status IS NULL THEN RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0003'; END IF;
    IF v_status = 'suspended' THEN RAISE EXCEPTION 'SUSPENDED' USING ERRCODE = 'P0001'; END IF;
    RAISE EXCEPTION 'ALREADY_ACTIVATED' USING ERRCODE = 'P0001';
  END IF;

  -- Wallet path: debit the fee in the SAME transaction (Paystack pays externally, so skip).
  -- If the wallet can't cover it, RAISE rolls back the activation above -> account stays inactive,
  -- no money taken. Only the activation winner ever reaches this, so no double-debit.
  IF p_paid_from = 'wallet' THEN
    UPDATE wallets
    SET balance = balance - v_fee,
        total_spent = COALESCE(total_spent, 0) + v_fee,
        updated_at = now()
    WHERE user_id = v_user AND balance >= v_fee;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  ok := true;
  RETURN NEXT;
END;
$$;

-- ── claim_sms_welcome_bonus (status-gated + duplicate guard) ────────────────
CREATE OR REPLACE FUNCTION claim_sms_welcome_bonus(
  p_account_id UUID,
  p_wholesale  NUMERIC
)
RETURNS TABLE(units_credited INT, outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bonus_units INT;
  v_claimed_id  UUID;
  v_result      TEXT;
  v_status      TEXT;
BEGIN
  SELECT (value->>'units')::INT INTO v_bonus_units
  FROM tenant_global_settings WHERE key = 'sms_welcome_bonus_credits';
  IF v_bonus_units IS NULL THEN
    RAISE EXCEPTION 'sms_welcome_bonus_credits not configured' USING ERRCODE = 'P0002';
  END IF;

  -- Defense-in-depth: only an active account may claim (the route also checks).
  SELECT status INTO v_status FROM sms_accounts WHERE id = p_account_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0003'; END IF;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'NOT_ACTIVATED' USING ERRCODE = 'P0001'; END IF;

  -- Single-claim guard.
  UPDATE sms_accounts
  SET bonus_claimed = true, bonus_claimed_at = now(), updated_at = now()
  WHERE id = p_account_id AND bonus_claimed = false
  RETURNING id INTO v_claimed_id;
  IF v_claimed_id IS NULL THEN RAISE EXCEPTION 'ALREADY_CLAIMED' USING ERRCODE = 'P0001'; END IF;

  SELECT cr.outcome INTO v_result
  FROM credit_sms_units_if_solvent(
    p_account_id, v_bonus_units, 'welcome_bonus',
    p_wholesale::INT, 'welcome-bonus-' || p_account_id::TEXT
  ) cr;

  -- A 'duplicate' here means the bonus ref already credited — impossible on the single guarded
  -- claim, so treat it as a conflict and RAISE (rolls back the bonus_claimed flip) rather than
  -- report a phantom success crediting zero units.
  IF v_result = 'duplicate' THEN
    RAISE EXCEPTION 'BONUS_CREDIT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  units_credited := v_bonus_units;
  outcome := COALESCE(v_result, 'pending');
  RETURN NEXT;
END;
$$;

-- ── Lock execution to the backend service identity only ─────────────────────
REVOKE ALL ON FUNCTION activate_sms_account(UUID, TEXT)        FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION activate_sms_account(UUID, TEXT)    TO service_role;
REVOKE ALL ON FUNCTION claim_sms_welcome_bonus(UUID, NUMERIC)  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION claim_sms_welcome_bonus(UUID, NUMERIC) TO service_role;
