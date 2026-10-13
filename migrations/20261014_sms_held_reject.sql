-- Phase 3b / Task 14: reject a campaign held for review (lib/sms/held-service.ts).
--
-- Why SQL and not TypeScript: once a held log leaves 'held', claim_sms_messages (20261013) no
-- longer protects its 'pending' messages, so the cron drain could claim and SEND a rejected
-- campaign in the gap between "log → failed" and "messages → failed". Doing the status flip, the
-- message close-out and the refund in ONE transaction (log row locked FOR UPDATE, still 'held'
-- while the messages are closed) removes that window and makes the refund all-or-nothing.
--
-- Refund source of truth: the log's UNREFUNDED, unsent sms_messages (sum of their segments) —
-- never credits_reserved (orphan / partial inserts exist). One ledger row per campaign
-- (reason 'campaign_refund', ref 'held_reject:<logId>', linked via send_log_id) instead of one per
-- message. The messages are marked refunded = true in the same transaction, so the per-message
-- refund_sms_message (drain / DLR close) can never refund them again.
--
-- Idempotent: a second call finds the log no longer 'held' and returns 'already_rejected'
-- (the review marker below) or 'not_held'. Nothing is changed by either.
--
-- The admin's reason is recorded on the log as policy_shadow.review (the existing admin-only
-- JSONB column) so the content-filter flag_reason is preserved.
--
-- Requires 20261013_sms_policy_enforcement.sql (held logs are only created once enforcement is on).
-- No-op for today's traffic: nothing calls it until an admin rejects a held campaign.

BEGIN;

CREATE OR REPLACE FUNCTION reject_held_sms_campaign(p_send_log_id BIGINT, p_reason TEXT, p_admin_id UUID)
RETURNS TABLE(
  out_outcome TEXT,             -- rejected | already_rejected | not_held | not_found
  out_status TEXT,              -- the log's status after the call
  out_account_id UUID,
  out_refunded_messages INT,
  out_refunded_credits INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l          RECORD;
  v_ref      TEXT := 'held_reject:' || p_send_log_id::text;
  v_n        INT := 0;
  v_credits  INT := 0;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, sms_account_id, status, policy_shadow INTO l
  FROM sms_send_logs WHERE id = p_send_log_id FOR UPDATE;
  IF NOT FOUND THEN
    out_outcome := 'not_found';
    RETURN NEXT; RETURN;
  END IF;

  out_account_id := l.sms_account_id;
  IF l.status <> 'held' THEN
    out_outcome := CASE
      WHEN l.status = 'failed' AND l.policy_shadow #>> '{review,outcome}' = 'rejected' THEN 'already_rejected'
      ELSE 'not_held'
    END;
    out_status := l.status;
    out_refunded_messages := 0;
    out_refunded_credits := 0;
    RETURN NEXT; RETURN;
  END IF;

  -- 1. Close the messages while the log is still 'held' (so the drain cannot claim any of them).
  --    attempts >= 3 keeps them out of claim_sms_messages' failed-retry branch for good.
  UPDATE sms_messages
  SET status = 'failed',
      attempts = GREATEST(attempts, 3),
      last_error = 'held_rejected',
      processed_at = now(),
      claimed_at = NULL
  WHERE send_log_id = p_send_log_id AND status IN ('pending', 'claimed', 'failed');

  -- 2. Refund every unrefunded, unsent message in one ledger row.
  SELECT count(*)::int, COALESCE(sum(segments), 0)::int INTO v_n, v_credits
  FROM sms_messages
  WHERE send_log_id = p_send_log_id AND NOT refunded AND status <> 'sent';

  IF v_credits > 0 AND NOT EXISTS (SELECT 1 FROM sms_unit_transactions WHERE ref = v_ref) THEN
    PERFORM adjust_sms_units(l.sms_account_id, v_credits, 'campaign_refund', v_ref);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REFUND_FAILED for send log %', p_send_log_id USING ERRCODE = 'P0001';
    END IF;
    UPDATE sms_unit_transactions SET send_log_id = p_send_log_id WHERE ref = v_ref;
  END IF;

  UPDATE sms_messages
  SET refunded = true, delivery_status = 'failed'
  WHERE send_log_id = p_send_log_id AND NOT refunded AND status <> 'sent';

  -- 3. Close the campaign.
  UPDATE sms_send_logs
  SET status = 'failed',
      credits_used = 0,
      completed_at = now(),
      policy_shadow = COALESCE(policy_shadow, '{}'::jsonb) || jsonb_build_object(
        'review', jsonb_build_object(
          'outcome', 'rejected',
          'reason', left(btrim(p_reason), 500),
          'by', p_admin_id,
          'at', now(),
          'refunded_credits', v_credits
        )
      )
  WHERE id = p_send_log_id;

  out_outcome := 'rejected';
  out_status := 'failed';
  out_refunded_messages := v_n;
  out_refunded_credits := v_credits;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION reject_held_sms_campaign(BIGINT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION reject_held_sms_campaign(BIGINT, TEXT, UUID) TO service_role;

COMMIT;
