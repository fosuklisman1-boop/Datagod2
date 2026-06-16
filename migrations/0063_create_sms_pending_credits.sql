-- Fully-backed units: internal SMS units must never exceed the Moolre wholesale balance.
-- A purchase that would breach SUM(unit_balance) <= wholesale is recorded here as PENDING
-- (the buyer paid but isn't credited yet); the settlement cron credits it once admin tops
-- up the Moolre wholesale SMS account.

CREATE TABLE IF NOT EXISTS sms_pending_credits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sms_account_id UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  units          INT  NOT NULL CHECK (units > 0),
  reason         TEXT NOT NULL,              -- bundle_wallet | bundle_paystack | admin_alloc
  ref            TEXT,                        -- payment ref (idempotency)
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','credited')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sms_pending_account ON sms_pending_credits(sms_account_id, status);
CREATE INDEX IF NOT EXISTS idx_sms_pending_pending ON sms_pending_credits(created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_pending_ref ON sms_pending_credits(ref) WHERE ref IS NOT NULL;

ALTER TABLE sms_pending_credits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_pending_owner_select ON sms_pending_credits;
CREATE POLICY sms_pending_owner_select ON sms_pending_credits
  FOR SELECT TO authenticated USING (
    sms_account_id IN (SELECT id FROM sms_accounts WHERE user_id = auth.uid())
  );

-- credit_sms_units_if_solvent: the ONLY entry point for issuing units. The caller fetches
-- the live Moolre wholesale balance (queryMoolreSmsBalance) and passes it as p_wholesale.
-- Serialized platform-wide via an advisory lock so concurrent purchases cannot over-commit.
-- outcome: 'credited' (units added now) | 'pending' (recorded, awaiting wholesale) |
--          'duplicate' (this ref was already processed — idempotent no-op).
CREATE OR REPLACE FUNCTION credit_sms_units_if_solvent(
  p_account_id UUID,
  p_units      INT,
  p_reason     TEXT,
  p_wholesale  INT,
  p_ref        TEXT DEFAULT NULL
)
RETURNS TABLE(outcome TEXT, balance_after INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_credited BIGINT;
  v_bal INT;
BEGIN
  IF p_units <= 0 THEN RAISE EXCEPTION 'p_units must be positive'; END IF;

  -- Serialize all credit issuance + settlement platform-wide.
  PERFORM pg_advisory_xact_lock(hashtext('sms_units_credit'));

  -- Idempotency: a ref already credited or already pending is a no-op.
  IF p_ref IS NOT NULL AND (
       EXISTS (SELECT 1 FROM sms_unit_transactions WHERE ref = p_ref)
    OR EXISTS (SELECT 1 FROM sms_pending_credits   WHERE ref = p_ref)
  ) THEN
    outcome := 'duplicate'; balance_after := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT COALESCE(SUM(unit_balance), 0) INTO v_total_credited FROM sms_accounts;

  IF v_total_credited + p_units <= p_wholesale THEN
    SELECT a.balance_after INTO v_bal FROM adjust_sms_units(p_account_id, p_units, p_reason, p_ref) AS a;
    IF v_bal IS NULL THEN RAISE EXCEPTION 'account % not found', p_account_id; END IF;
    outcome := 'credited'; balance_after := v_bal; RETURN NEXT;
  ELSE
    INSERT INTO sms_pending_credits (sms_account_id, units, reason, ref)
    VALUES (p_account_id, p_units, p_reason, p_ref);
    outcome := 'pending'; balance_after := NULL; RETURN NEXT;
  END IF;
END;
$$;

-- settle_pending_sms_credits: credit pending rows oldest-first while they fit under the
-- (freshly fetched) wholesale balance. Called by the pending-credits cron after admin
-- tops up the Moolre wholesale. Same advisory lock as issuance to keep the invariant.
CREATE OR REPLACE FUNCTION settle_pending_sms_credits(p_wholesale INT)
RETURNS TABLE(credited_count INT, credited_units INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  r RECORD;
  v_total BIGINT;
  v_cnt INT := 0;
  v_units INT := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sms_units_credit'));
  SELECT COALESCE(SUM(unit_balance), 0) INTO v_total FROM sms_accounts;

  FOR r IN
    SELECT * FROM sms_pending_credits WHERE status = 'pending' ORDER BY created_at
  LOOP
    IF v_total + r.units <= p_wholesale THEN
      PERFORM adjust_sms_units(r.sms_account_id, r.units, r.reason, r.ref);
      UPDATE sms_pending_credits SET status = 'credited', credited_at = now() WHERE id = r.id;
      v_total := v_total + r.units;
      v_cnt   := v_cnt + 1;
      v_units := v_units + r.units;
    END IF;
  END LOOP;

  credited_count := v_cnt; credited_units := v_units; RETURN NEXT;
END;
$$;
