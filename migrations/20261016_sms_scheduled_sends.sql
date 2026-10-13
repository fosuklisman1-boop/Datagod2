-- Phase 4a: scheduled SMS sends.
--
-- A scheduled send is a held-shaped log: sms_send_logs.status = 'scheduled' + scheduled_for, its
-- sms_messages stored 'pending' and unclaimed (claim_sms_messages already skips 'scheduled' logs).
--   * sms_promote_due_scheduled  - per-minute cron gate: atomically flips due logs scheduled -> queued.
--   * cancel_scheduled_sms_campaign - customer/system cancel, one transaction, full refund, idempotent
--     (modelled line-by-line on reject_held_sms_campaign, 20261014_sms_held_reject.sql).
--   * sms_account_usage - re-created from 20261015 with ONE change: cancelled logs are excluded.
-- Also adds sms_send_logs.source ('campaign' | 'order_confirmation') for Records/Credits labels.
-- The new columns are deliberately NOT granted to `authenticated` (all reads are service-role).
-- Additive: nothing calls the new functions until the Phase 4a code ships.

BEGIN;
-- Fail fast instead of stalling sends/drain behind a long-running reader (ALTER TABLE takes an
-- ACCESS EXCLUSIVE lock); if it times out, just re-run.
SET LOCAL lock_timeout = '5s';

-- 1. Columns, constraint, index ---------------------------------------------------------------
ALTER TABLE sms_send_logs
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'campaign';

ALTER TABLE sms_send_logs DROP CONSTRAINT IF EXISTS sms_send_logs_source_check;
ALTER TABLE sms_send_logs
  ADD CONSTRAINT sms_send_logs_source_check CHECK (source IN ('campaign', 'order_confirmation'));

CREATE INDEX IF NOT EXISTS idx_sms_send_logs_due
  ON sms_send_logs (scheduled_for) WHERE status = 'scheduled';

-- 2. Promote due scheduled logs ----------------------------------------------------------------
-- One statement = the atomic gate. FOR UPDATE SKIP LOCKED means concurrent cron runs never take the
-- same log, and a log locked by a concurrent cancel is skipped (the cancel wins).
CREATE OR REPLACE FUNCTION sms_promote_due_scheduled(p_limit INT)
RETURNS TABLE(out_id BIGINT, out_account_id UUID, out_sender_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT s.id
    FROM sms_send_logs s
    WHERE s.status = 'scheduled' AND s.scheduled_for <= now()
      -- never promote a suspended account's send (the cron cancels + refunds those instead)
      AND NOT EXISTS (SELECT 1 FROM sms_accounts a WHERE a.id = s.sms_account_id AND a.status = 'suspended')
    ORDER BY s.scheduled_for, s.id
    LIMIT GREATEST(p_limit, 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE sms_send_logs l
  SET status = 'queued'
  FROM due
  WHERE l.id = due.id
  RETURNING l.id, l.sms_account_id, l.sender_id;
END;
$$;

REVOKE ALL ON FUNCTION sms_promote_due_scheduled(INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_promote_due_scheduled(INT) TO service_role;

-- 3. Cancel a scheduled campaign ---------------------------------------------------------------
-- Same locking/refund/idempotency approach as reject_held_sms_campaign: the log is locked FOR UPDATE
-- and stays 'scheduled' while its messages are closed (so neither the drain nor the promote cron can
-- act on them), then one ledger row refunds the unrefunded unsent messages' segments.
-- p_account_id: the customer route passes the caller's account (ownership enforced); the system cron
-- (suspended account) passes NULL.
CREATE OR REPLACE FUNCTION cancel_scheduled_sms_campaign(
  p_send_log_id BIGINT,
  p_account_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT 'cancelled'
)
RETURNS TABLE(
  out_result TEXT,              -- cancelled | already_cancelled | not_scheduled | not_found
  out_refunded INT              -- credits refunded by THIS call
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l          RECORD;
  v_ref      TEXT := 'sched_cancel:' || p_send_log_id::text;
  v_refund   INT := 0;
BEGIN
  SELECT id, sms_account_id, status, policy_shadow INTO l
  FROM sms_send_logs WHERE id = p_send_log_id FOR UPDATE;
  IF NOT FOUND THEN
    out_result := 'not_found';
    out_refunded := 0;
    RETURN NEXT; RETURN;
  END IF;
  IF p_account_id IS NOT NULL AND l.sms_account_id <> p_account_id THEN
    out_result := 'not_found';
    out_refunded := 0;
    RETURN NEXT; RETURN;
  END IF;

  IF l.status <> 'scheduled' THEN
    out_result := CASE
      WHEN l.status = 'failed' AND l.policy_shadow #>> '{review,outcome}' = 'cancelled' THEN 'already_cancelled'
      ELSE 'not_scheduled'
    END;
    out_refunded := 0;
    RETURN NEXT; RETURN;
  END IF;

  -- 1. Close the messages while the log is still 'scheduled'.
  --    attempts >= 3 keeps them out of claim_sms_messages' failed-retry branch for good.
  UPDATE sms_messages
  SET status = 'failed',
      attempts = GREATEST(attempts, 3),
      last_error = 'scheduled_cancelled',
      processed_at = now(),
      claimed_at = NULL
  WHERE send_log_id = p_send_log_id AND status IN ('pending', 'claimed', 'failed');

  -- 2. Refund every unrefunded, unsent message in one ledger row.
  SELECT COALESCE(sum(segments), 0)::int INTO v_refund
  FROM sms_messages
  WHERE send_log_id = p_send_log_id AND NOT refunded AND status <> 'sent';

  IF v_refund > 0 AND NOT EXISTS (SELECT 1 FROM sms_unit_transactions WHERE ref = v_ref) THEN
    PERFORM adjust_sms_units(l.sms_account_id, v_refund, 'campaign_refund', v_ref);
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
          'outcome', 'cancelled',
          'reason', left(btrim(COALESCE(p_reason, 'cancelled')), 500),
          'at', now(),
          'refunded', v_refund
        )
      )
  WHERE id = p_send_log_id;

  out_result := 'cancelled';
  out_refunded := v_refund;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION cancel_scheduled_sms_campaign(BIGINT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION cancel_scheduled_sms_campaign(BIGINT, UUID, TEXT) TO service_role;

-- 4. sms_account_usage: also exclude cancelled scheduled sends ----------------------------------
-- Identical to migrations/20261015_sms_usage_exclude_rejected.sql except the outcome test.
-- (Controller: diff against pg_get_functiondef before applying.)
CREATE OR REPLACE FUNCTION sms_account_usage(p_account_id UUID)
RETURNS TABLE(sends_last_hour INT, recipients_last_24h BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (count(*) FILTER (WHERE created_at >= now() - interval '1 hour'))::int,
    COALESCE(sum(recipients_count), 0)::bigint
  FROM sms_send_logs
  WHERE sms_account_id = p_account_id
    AND status <> 'blocked'
    AND NOT (
      status = 'failed'
      AND (
        COALESCE(policy_shadow->'review'->>'outcome', '') IN ('rejected', 'cancelled')
        OR credits_reserved = 0
      )
    )
    AND created_at >= now() - interval '24 hours';
$$;

REVOKE ALL ON FUNCTION sms_account_usage(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sms_account_usage(UUID) TO service_role;

COMMIT;
