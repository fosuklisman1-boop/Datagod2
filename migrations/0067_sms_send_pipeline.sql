-- migrations/0067_sms_send_pipeline.sql
-- Milestone 3: Metered Send Pipeline (queue + cron drain engine — mirrors broadcast-drain).
--   sms_send_logs       : one row per send (parent / audit / moderation feed for M4)
--   sms_messages        : per-recipient queue rows, drained by cron (FOR UPDATE SKIP LOCKED)
--   sms_refund_failures : credits that couldn't be refunded at send time (replay ledger)
--   debit_sms_for_send  : atomic activation+suspend gate + unit debit (no TOCTOU)
--   claim_sms_messages  : atomically claim the next batch to send (attempt-capped)
--   recompute_sms_send_result : roll the per-recipient outcomes up into the parent status

-- ── sms_send_logs (the send record) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_send_logs (
  id               BIGSERIAL PRIMARY KEY,
  sms_account_id   UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  message          TEXT NOT NULL,
  sender_id        TEXT,                                  -- chosen sender (M5); null = platform default
  recipients_count INT  NOT NULL CHECK (recipients_count > 0),
  segments         INT  NOT NULL CHECK (segments > 0),
  credits_reserved INT  NOT NULL CHECK (credits_reserved >= 0),  -- debited up front at enqueue
  credits_used     INT  NOT NULL DEFAULT 0 CHECK (credits_used >= 0),  -- settled as recipients send
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','sending','sent','partial','failed','blocked')),
  flagged          BOOLEAN NOT NULL DEFAULT false,
  flag_reason      TEXT,
  provider         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sms_send_logs_account_time ON sms_send_logs(sms_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_send_logs_flagged ON sms_send_logs(sms_account_id) WHERE flagged = true;

ALTER TABLE sms_send_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_send_logs_owner_select ON sms_send_logs;
CREATE POLICY sms_send_logs_owner_select ON sms_send_logs
  FOR SELECT TO authenticated
  USING (sms_account_id IN (SELECT id FROM sms_accounts WHERE user_id = auth.uid()));

-- ── sms_messages (per-recipient queue) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  send_log_id      BIGINT NOT NULL REFERENCES sms_send_logs(id) ON DELETE CASCADE,
  sms_account_id   UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  phone            TEXT NOT NULL,
  rendered_message TEXT NOT NULL,
  segments         INT  NOT NULL CHECK (segments > 0),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','sent','failed')),
  attempts         INT  NOT NULL DEFAULT 0,
  last_error       TEXT,
  provider         TEXT,
  ref              TEXT,                                  -- provider tracking ref (delivery sync)
  claimed_at       TIMESTAMPTZ,
  processed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_messages_send_log ON sms_messages(send_log_id);
-- Hot "what's left to send" lookup stays tiny even as sent rows pile up.
CREATE INDEX IF NOT EXISTS idx_sms_messages_drain ON sms_messages(created_at) WHERE status IN ('pending','failed');

ALTER TABLE sms_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_messages_owner_select ON sms_messages;
CREATE POLICY sms_messages_owner_select ON sms_messages
  FOR SELECT TO authenticated
  USING (sms_account_id IN (SELECT id FROM sms_accounts WHERE user_id = auth.uid()));

-- ── sms_refund_failures (refund replay ledger) ──────────────────────────────
CREATE TABLE IF NOT EXISTS sms_refund_failures (
  id             BIGSERIAL PRIMARY KEY,
  sms_account_id UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  credits        INT  NOT NULL CHECK (credits > 0),
  reason         TEXT NOT NULL,
  resolved       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sms_refund_failures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_refund_failures_owner_select ON sms_refund_failures;
CREATE POLICY sms_refund_failures_owner_select ON sms_refund_failures
  FOR SELECT TO authenticated
  USING (sms_account_id IN (SELECT id FROM sms_accounts WHERE user_id = auth.uid()));

-- ── debit_sms_for_send: atomic activation/suspend gate + unit debit ─────────
-- Raises (P0001): 'NOT_ACTIVATED' (status not active/missing) | 'SUSPENDED' |
-- 'INSUFFICIENT_CREDITS' (adjust_sms_units returned no row). Gate + debit are in one
-- statement sequence with no application round-trip between them (no TOCTOU).
CREATE OR REPLACE FUNCTION debit_sms_for_send(
  p_account_id UUID,
  p_credits    INT
)
RETURNS TABLE(balance_after INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_bal    INT;
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

  balance_after := v_bal;
  RETURN NEXT;
END;
$$;

-- ── claim_sms_messages: atomically grab the next batch to send (global) ─────
-- Mirrors claim_broadcast_recipients: pending OR (failed under the attempt cap),
-- flips to 'claimed' + bumps attempts, FOR UPDATE SKIP LOCKED so concurrent drains
-- never grab the same row. max_attempts is the hard stop that makes retry terminate.
CREATE OR REPLACE FUNCTION claim_sms_messages(lim INT, max_attempts INT DEFAULT 3)
RETURNS SETOF sms_messages
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE sms_messages m
  SET status = 'claimed', attempts = m.attempts + 1, claimed_at = now()
  WHERE m.id IN (
    SELECT id FROM sms_messages
    WHERE status = 'pending' OR (status = 'failed' AND attempts < max_attempts)
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT lim
  )
  RETURNING m.*;
END;
$$;

-- ── recompute_sms_send_result: roll per-recipient outcomes into the parent ──
-- credits_used = segments of sent recipients. status: sent (all sent) | partial
-- (some sent, some terminally failed) | failed (none sent) while still draining -> sending.
CREATE OR REPLACE FUNCTION recompute_sms_send_result(p_send_log_id BIGINT, max_attempts INT DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_total INT; v_sent INT; v_failed_final INT; v_outstanding INT; v_used INT;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE status = 'sent'),
    count(*) FILTER (WHERE status = 'failed' AND attempts >= max_attempts),
    count(*) FILTER (WHERE status IN ('pending','claimed') OR (status = 'failed' AND attempts < max_attempts)),
    COALESCE(sum(segments) FILTER (WHERE status = 'sent'), 0)
  INTO v_total, v_sent, v_failed_final, v_outstanding, v_used
  FROM sms_messages WHERE send_log_id = p_send_log_id;

  UPDATE sms_send_logs
  SET credits_used = v_used,
      status = CASE
        WHEN v_outstanding > 0 THEN 'sending'
        WHEN v_sent = 0        THEN 'failed'
        WHEN v_failed_final > 0 THEN 'partial'
        ELSE 'sent'
      END,
      completed_at = CASE WHEN v_outstanding = 0 THEN now() ELSE NULL END
  WHERE id = p_send_log_id;
END;
$$;

-- ── Lock privileged functions to the backend service identity ───────────────
REVOKE ALL ON FUNCTION debit_sms_for_send(UUID, INT)             FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION debit_sms_for_send(UUID, INT)         TO service_role;
REVOKE ALL ON FUNCTION claim_sms_messages(INT, INT)              FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION claim_sms_messages(INT, INT)          TO service_role;
REVOKE ALL ON FUNCTION recompute_sms_send_result(BIGINT, INT)    FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION recompute_sms_send_result(BIGINT, INT) TO service_role;
