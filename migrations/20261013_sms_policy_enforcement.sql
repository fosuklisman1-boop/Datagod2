-- Phase 3b / Task 13: send-policy enforcement support (lib/sms/enforcement.ts).
-- MUST be applied BEFORE sms_policy_enforced is ever set to true:
--   * record_sms_flags  — the atomic fraud-flag recorder the Phase 1 plan deferred to Phase 3
--                         (it was never created). Without it, blocked sends still block, but no
--                         flags are counted (no auto-suspend / review hold).
--   * claim_sms_messages — now skips messages whose campaign is 'held' (or 'scheduled'). Held
--                         campaigns insert their sms_messages as plain 'pending' rows; without
--                         this guard the cron drain WOULD SEND THEM.
-- Both are no-ops for today's traffic (nothing creates held logs while enforcement is off).

BEGIN;

-- ── record_sms_flags ───────────────────────────────────────────────────────────────────────
-- p_flags: JSON array of {severity: "fraud"|"info", reason, matched}. One transaction, account
-- row locked (FOR UPDATE) so concurrent blocked sends cannot race the counter:
--   1. insert one sms_flags row per flag (status 'open');
--   2. fraud_flag_count += number of fraud flags;
--   3. if fraud flags were added and fraud_flag_count >= p_auto_suspend → status 'suspended'
--      (only from 'active'; never touches 'inactive');
--   4. if open flags for the account >= p_review_threshold → review_hold = true.
-- The platform owner account (owner_type 'platform') gets its flags recorded but is never
-- auto-suspended or auto-held (that would stop platform traffic).
CREATE OR REPLACE FUNCTION record_sms_flags(
  p_account_id       UUID,
  p_send_log_id      BIGINT,
  p_flags            JSONB,
  p_auto_suspend     INT,
  p_review_threshold INT
)
RETURNS TABLE(out_fraud_flag_count INT, out_suspended BOOLEAN, out_review_hold BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status     TEXT;
  v_owner      TEXT;
  v_count      INT;
  v_review     BOOLEAN;
  v_new_fraud  INT;
  v_open       INT;
BEGIN
  IF p_flags IS NULL OR jsonb_typeof(p_flags) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_FLAGS' USING ERRCODE = 'P0001';
  END IF;
  IF p_auto_suspend IS NULL OR p_auto_suspend < 1 OR p_review_threshold IS NULL OR p_review_threshold < 1 THEN
    RAISE EXCEPTION 'INVALID_THRESHOLDS' USING ERRCODE = 'P0001';
  END IF;

  SELECT status, owner_type INTO v_status, v_owner FROM sms_accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sms_account % not found', p_account_id USING ERRCODE = 'P0003';
  END IF;

  INSERT INTO sms_flags (sms_account_id, send_log_id, severity, reason, matched)
  SELECT p_account_id, p_send_log_id, f.severity, left(f.reason, 500), left(f.matched, 500)
  FROM jsonb_to_recordset(p_flags) AS f(severity TEXT, reason TEXT, matched TEXT)
  WHERE f.severity IN ('fraud', 'info') AND f.reason IS NOT NULL;

  SELECT count(*)::int INTO v_new_fraud
  FROM jsonb_to_recordset(p_flags) AS f(severity TEXT, reason TEXT, matched TEXT)
  WHERE f.severity = 'fraud' AND f.reason IS NOT NULL;

  UPDATE sms_accounts SET fraud_flag_count = fraud_flag_count + v_new_fraud
  WHERE id = p_account_id
  RETURNING sms_accounts.fraud_flag_count, sms_accounts.review_hold INTO v_count, v_review;

  IF v_owner <> 'platform' THEN
    IF v_new_fraud > 0 AND v_count >= p_auto_suspend AND v_status = 'active' THEN
      UPDATE sms_accounts SET status = 'suspended', updated_at = now() WHERE id = p_account_id;
      v_status := 'suspended';
    END IF;

    SELECT count(*)::int INTO v_open FROM sms_flags WHERE sms_account_id = p_account_id AND status = 'open';
    IF v_open >= p_review_threshold AND NOT v_review THEN
      UPDATE sms_accounts SET review_hold = true, updated_at = now() WHERE id = p_account_id;
      v_review := true;
    END IF;
  END IF;

  out_fraud_flag_count := v_count;
  out_suspended := (v_status = 'suspended');
  out_review_hold := v_review;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION record_sms_flags(UUID, BIGINT, JSONB, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION record_sms_flags(UUID, BIGINT, JSONB, INT, INT) TO service_role;

-- ── claim_sms_messages: same contract as 0067, plus the held/scheduled guard ────────────────
-- Held campaigns are debited and their messages stored 'pending' (un-dispatched) until an admin
-- releases or rejects them. The drain must never claim those rows. (send-drain.ts also checks
-- after claiming, as defence in depth.)
CREATE OR REPLACE FUNCTION claim_sms_messages(lim INT, max_attempts INT DEFAULT 3)
RETURNS SETOF sms_messages
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE sms_messages m
  SET status = 'claimed', attempts = m.attempts + 1, claimed_at = now()
  WHERE m.id IN (
    SELECT q.id FROM sms_messages q
    WHERE (q.status = 'pending' OR (q.status = 'failed' AND q.attempts < max_attempts))
      AND NOT EXISTS (
        SELECT 1 FROM sms_send_logs l
        WHERE l.id = q.send_log_id AND l.status IN ('held', 'scheduled')
      )
    ORDER BY q.created_at
    FOR UPDATE OF q SKIP LOCKED
    LIMIT lim
  )
  RETURNING m.*;
END;
$$;

REVOKE ALL ON FUNCTION claim_sms_messages(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION claim_sms_messages(INT, INT) TO service_role;

COMMIT;
