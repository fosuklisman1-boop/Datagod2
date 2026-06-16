-- migrations/0065_sms_activation_gate.sql
-- Adds activation gate columns to sms_accounts, creates tenant_global_settings table,
-- and creates activate_sms_account + claim_sms_welcome_bonus RPCs.
-- Apply via Supabase dashboard SQL editor or Management API.

-- ── 1. Widen the status CHECK and add activation columns ───────────────────
ALTER TABLE sms_accounts
  DROP CONSTRAINT IF EXISTS sms_accounts_status_check;

ALTER TABLE sms_accounts
  ADD CONSTRAINT sms_accounts_status_check
    CHECK (status IN ('inactive', 'active', 'suspended'));

ALTER TABLE sms_accounts
  ADD COLUMN IF NOT EXISTS activated_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amount_paid     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS paid_from       TEXT,
  ADD COLUMN IF NOT EXISTS bonus_claimed   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bonus_claimed_at TIMESTAMPTZ;

-- Change default for new rows to 'inactive' (metered accounts must activate).
-- Platform accounts will be set active below and via the get_or_create RPC logic.
ALTER TABLE sms_accounts ALTER COLUMN status SET DEFAULT 'inactive';

-- ── 2. Reconcile existing rows ──────────────────────────────────────────────
-- No live metered sending exists yet, so all shop/sub_agent rows go to inactive.
-- Platform (admin) rows keep active status.
UPDATE sms_accounts SET status = 'inactive'
WHERE owner_type IN ('shop', 'sub_agent') AND status = 'active';

UPDATE sms_accounts SET status = 'active'
WHERE owner_type = 'platform' AND status = 'inactive';

-- ── 3. tenant_global_settings ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_global_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

ALTER TABLE tenant_global_settings ENABLE ROW LEVEL SECURITY;

-- Public read (tenants need the activation fee without being admin)
DROP POLICY IF EXISTS tgs_authenticated_read ON tenant_global_settings;
CREATE POLICY tgs_authenticated_read ON tenant_global_settings
  FOR SELECT TO authenticated USING (true);

-- Admin write only
DROP POLICY IF EXISTS tgs_admin_write ON tenant_global_settings;
CREATE POLICY tgs_admin_write ON tenant_global_settings
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
        AND raw_user_meta_data->>'role' = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
        AND raw_user_meta_data->>'role' = 'admin'
    )
  );

GRANT SELECT ON tenant_global_settings TO authenticated;
GRANT ALL ON tenant_global_settings TO service_role;

-- Seed defaults (idempotent)
INSERT INTO tenant_global_settings (key, value)
VALUES
  ('sms_activation_fee',        '{"amount": 20}'),
  ('sms_welcome_bonus_credits', '{"units":  10}')
ON CONFLICT (key) DO NOTHING;

-- ── 4. activate_sms_account RPC ────────────────────────────────────────────
-- Sets status='active', records activated_at/amount_paid/paid_from.
-- Raises ALREADY_ACTIVATED (P0001) if account is already active/suspended-active.
-- p_paid_from: 'wallet' | 'paystack'
-- Caller must have already debited the payment (wallet debit or Paystack webhook).
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
  v_fee     NUMERIC(10,2);
  v_status  TEXT;
BEGIN
  -- Read fee from settings
  SELECT (value->>'amount')::NUMERIC INTO v_fee
  FROM tenant_global_settings
  WHERE key = 'sms_activation_fee';

  IF v_fee IS NULL THEN
    RAISE EXCEPTION 'sms_activation_fee not configured' USING ERRCODE = 'P0002';
  END IF;

  -- Check current status
  SELECT status INTO v_status FROM sms_accounts WHERE id = p_account_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0003';
  END IF;

  IF v_status = 'active' THEN
    RAISE EXCEPTION 'ALREADY_ACTIVATED' USING ERRCODE = 'P0001';
  END IF;

  -- A suspended (admin-disabled) account must NOT be able to re-activate itself by paying.
  -- Only an 'inactive' account may activate.
  IF v_status = 'suspended' THEN
    RAISE EXCEPTION 'SUSPENDED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE sms_accounts
  SET
    status       = 'active',
    activated_at  = now(),
    amount_paid   = v_fee,
    paid_from     = p_paid_from,
    updated_at    = now()
  WHERE id = p_account_id;

  ok := true;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION activate_sms_account(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activate_sms_account(UUID, TEXT) TO service_role;

-- ── 5. claim_sms_welcome_bonus RPC ──────────────────────────────────────────
-- Single-claim guarded via UPDATE … WHERE bonus_claimed = false RETURNING.
-- Raises ALREADY_CLAIMED (P0001) if bonus already taken.
-- Credits units through credit_sms_units_if_solvent (caller passes wholesale).
-- Returns: (units_credited INT, outcome TEXT)
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
BEGIN
  -- Read bonus from settings
  SELECT (value->>'units')::INT INTO v_bonus_units
  FROM tenant_global_settings
  WHERE key = 'sms_welcome_bonus_credits';

  IF v_bonus_units IS NULL THEN
    RAISE EXCEPTION 'sms_welcome_bonus_credits not configured' USING ERRCODE = 'P0002';
  END IF;

  -- Single-claim guard: atomically flip bonus_claimed=true only if currently false.
  UPDATE sms_accounts
  SET bonus_claimed    = true,
      bonus_claimed_at = now(),
      updated_at       = now()
  WHERE id = p_account_id
    AND bonus_claimed = false
  RETURNING id INTO v_claimed_id;

  IF v_claimed_id IS NULL THEN
    RAISE EXCEPTION 'ALREADY_CLAIMED' USING ERRCODE = 'P0001';
  END IF;

  -- Issue units through solvency gate (same function all credit paths use).
  SELECT cr.outcome INTO v_result
  FROM credit_sms_units_if_solvent(
    p_account_id,
    v_bonus_units,
    'welcome_bonus',
    p_wholesale,
    'welcome-bonus-' || p_account_id::TEXT
  ) cr;

  units_credited := v_bonus_units;
  outcome := COALESCE(v_result, 'pending');
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION claim_sms_welcome_bonus(UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_sms_welcome_bonus(UUID, NUMERIC) TO service_role;
