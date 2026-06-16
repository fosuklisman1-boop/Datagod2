-- adjust_sms_units: the ONLY way to change a unit balance. Race-safe (the WHERE guard
-- prevents going negative under concurrency) and atomic (balance update + ledger row in
-- one statement). Returns the new balance; returns NO rows if the account is missing or
-- a debit would overdraw — callers treat "no rows" as "insufficient units".

CREATE OR REPLACE FUNCTION adjust_sms_units(
  p_account_id  UUID,
  p_delta       INT,
  p_reason      TEXT,
  p_ref         TEXT DEFAULT NULL,
  p_campaign_id UUID DEFAULT NULL
)
RETURNS TABLE(balance_after INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new INT;
BEGIN
  UPDATE sms_accounts
  SET unit_balance = unit_balance + p_delta,
      updated_at = now()
  WHERE id = p_account_id
    AND unit_balance + p_delta >= 0
  RETURNING unit_balance INTO v_new;

  IF NOT FOUND THEN
    RETURN; -- missing account or would overdraw
  END IF;

  INSERT INTO sms_unit_transactions (sms_account_id, delta, reason, balance_after, ref, campaign_id)
  VALUES (p_account_id, p_delta, p_reason, v_new, p_ref, p_campaign_id);

  balance_after := v_new;
  RETURN NEXT;
END;
$$;

-- get_or_create_sms_account: idempotently resolves a user's single SMS account.
CREATE OR REPLACE FUNCTION get_or_create_sms_account(
  p_user_id    UUID,
  p_owner_type TEXT,
  p_owner_id   UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO sms_accounts (user_id, owner_type, owner_id)
  VALUES (p_user_id, p_owner_type, p_owner_id)
  ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
