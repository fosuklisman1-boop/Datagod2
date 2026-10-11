-- Phase 3b / Task 13 review fixes. Apply AFTER 20261013_sms_policy_enforcement.sql and BEFORE
-- sms_policy_enforced is ever set to true. No-op for today's traffic (the lease is only used by
-- enforced sends).

BEGIN;

-- ── Per-account send lease (lib/sms/enforcement.ts trySendLock / releaseSendLock) ─────────────
-- Usage (sms_account_usage) counts a send only once its log row exists, so parallel enforced
-- sends would all read the same usage and pass the caps together. An enforced send takes this
-- lease before reading usage and releases it after its last log row is written.
ALTER TABLE sms_accounts ADD COLUMN IF NOT EXISTS send_lock_until TIMESTAMPTZ;

-- Single atomic UPDATE: true only for the caller that set the lease.
CREATE OR REPLACE FUNCTION sms_try_send_lock(p_account_id UUID, p_seconds INT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INT;
BEGIN
  IF p_seconds IS NULL OR p_seconds < 1 OR p_seconds > 600 THEN
    RAISE EXCEPTION 'INVALID_SECONDS' USING ERRCODE = 'P0001';
  END IF;
  UPDATE sms_accounts
  SET send_lock_until = now() + make_interval(secs => p_seconds)
  WHERE id = p_account_id
    AND (send_lock_until IS NULL OR send_lock_until < now());
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION sms_release_send_lock(p_account_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE sms_accounts SET send_lock_until = NULL WHERE id = p_account_id;
$$;

REVOKE ALL ON FUNCTION sms_try_send_lock(UUID, INT)     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_try_send_lock(UUID, INT) TO service_role;
REVOKE ALL ON FUNCTION sms_release_send_lock(UUID)      FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_release_send_lock(UUID)  TO service_role;

COMMIT;
