-- Phase 3 / Task 2: link send debits to their campaign in the unit ledger.
-- debit_sms_for_send now also returns the ledger row id (debit_tx_id) so enqueueSend can set
-- sms_unit_transactions.send_log_id once the send log exists. balance_after is unchanged, so
-- existing callers that read only balance_after keep working. Forward-only: older debit rows
-- stay unlinked (UI falls back to "SMS campaign").
-- Return type changes, so the function must be dropped first (CREATE OR REPLACE cannot).

BEGIN;

DROP FUNCTION IF EXISTS debit_sms_for_send(UUID, INT);

CREATE FUNCTION debit_sms_for_send(
  p_account_id UUID,
  p_credits    INT
)
RETURNS TABLE(balance_after INT, debit_tx_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_bal    INT;
  v_tx     BIGINT;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  SELECT status INTO v_status FROM sms_accounts WHERE id = p_account_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'NOT_ACTIVATED' USING ERRCODE = 'P0001'; END IF;
  IF v_status = 'suspended' THEN RAISE EXCEPTION 'SUSPENDED' USING ERRCODE = 'P0001'; END IF;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'NOT_ACTIVATED' USING ERRCODE = 'P0001'; END IF;

  SELECT a.balance_after INTO v_bal
  FROM adjust_sms_units(p_account_id, -p_credits, 'campaign_send') a;

  IF v_bal IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS' USING ERRCODE = 'P0001';
  END IF;

  -- adjust_sms_units holds the account row lock until this transaction ends, so the newest
  -- campaign_send row for this account is the one it just wrote (no concurrent interleave).
  SELECT t.id INTO v_tx
  FROM sms_unit_transactions t
  WHERE t.sms_account_id = p_account_id AND t.reason = 'campaign_send'
  ORDER BY t.id DESC
  LIMIT 1;

  balance_after := v_bal;
  debit_tx_id := v_tx;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION debit_sms_for_send(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION debit_sms_for_send(UUID, INT) TO service_role;

COMMIT;
