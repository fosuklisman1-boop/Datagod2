-- Hubtel batch delivery reports never matched (live 2026-10-13): the batch status reply
-- (GET /v1/messages/batch/{batchId}) gives each recipient a messageId DIFFERENT from the one the
-- send reply gave us (stored as provider_message_id), so apply_sms_delivery_reports, which matched
-- only on provider_message_id, matched nothing: no delivery status or cost was ever recorded, and
-- close_stale_sms_deliveries would close + REFUND delivered messages after 72 h.
--
-- Fix: batch report rows now also carry bid (batch id) and "to" (recipient). A report that matches
-- no row by id falls back to (provider_batch_id, last 9 digits of the phone), strictly one-to-one:
-- * the report id is stored on the settled row in provider_dlr_message_id (UNIQUE), so a report
--   that was already applied matches that row by id on every later poll and never falls back again
--   (the batch reply lists every recipient on every poll, delivered ones included);
-- * within one call each fallback match consumes its row (v_used), so duplicate phones in one batch
--   consume reports in created_at order and one report never settles two rows;
-- * a row whose own send-time id appears in this call's reports is left for that report;
-- * applies for the same batch are serialized (advisory xact lock) before the existence check.
-- provider_message_id is never overwritten: it keeps the send-time id (audit, singles polling and
-- mark_sms_dlr_checked use it). Rows matching by id behave exactly as before. Malformed report rows
-- are skipped, never raised. Behaviour for singles (bid null) is unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS provider_dlr_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_provider_dlr_msg
  ON sms_messages(provider_dlr_message_id) WHERE provider_dlr_message_id IS NOT NULL;

-- Apply polled delivery reports. p_rows: [{mid, state: delivered|failed|pending, rate, at, bid, to}]
CREATE OR REPLACE FUNCTION apply_sms_delivery_reports(p_rows JSONB)
RETURNS TABLE(out_message_id UUID, out_send_log_id BIGINT, out_outcome TEXT, out_refunded BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e JSONB;
  m RECORD;
  v_mid TEXT;
  v_state TEXT;
  v_rate NUMERIC;
  v_at TIMESTAMPTZ;
  v_bid TEXT;
  v_to TEXT;
  v_id UUID;
  v_send_log_id BIGINT;
  v_mids TEXT[];
  v_used UUID[] := '{}';
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RETURN; END IF;

  -- Every message id reported in this call.
  SELECT COALESCE(array_agg(r->>'mid'), '{}') INTO v_mids
  FROM jsonb_array_elements(p_rows) AS r
  WHERE jsonb_typeof(r) = 'object' AND jsonb_typeof(r->'mid') = 'string';

  FOR e IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    -- Malformed rows are skipped.
    CONTINUE WHEN jsonb_typeof(e) IS DISTINCT FROM 'object';
    CONTINUE WHEN jsonb_typeof(e->'mid') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'state') IS DISTINCT FROM 'string';
    v_mid := e->>'mid';
    v_state := e->>'state';
    CONTINUE WHEN v_mid = '';

    v_rate := CASE
      WHEN jsonb_typeof(e->'rate') = 'number' THEN (e->>'rate')::numeric
      WHEN jsonb_typeof(e->'rate') = 'string' AND (e->>'rate') ~ '^\s*\d+(\.\d+)?\s*$' THEN trim(e->>'rate')::numeric
    END;
    IF v_rate IS NOT NULL AND (v_rate < 0 OR v_rate >= 9999.9999) THEN v_rate := NULL; END IF; -- cost_ghs is NUMERIC(8,4)

    v_at := NULL;
    IF jsonb_typeof(e->'at') = 'string' THEN
      BEGIN v_at := (e->>'at')::timestamptz; EXCEPTION WHEN others THEN v_at := NULL; END;
    END IF;

    v_bid := CASE WHEN jsonb_typeof(e->'bid') = 'string' AND (e->>'bid') <> '' THEN e->>'bid' END;
    v_to := CASE WHEN jsonb_typeof(e->'to') = 'string' THEN regexp_replace(e->>'to', '\D', '', 'g') END;
    IF v_to IS NOT NULL AND length(v_to) < 9 THEN v_to := NULL; END IF;

    -- Serialize applies for one batch so two concurrent polls can never bind one report twice.
    IF v_bid IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('sms_dlr_batch:' || v_bid, 0)); END IF;

    -- 1. Matched by id (send-time id, or a report id bound on an earlier poll): unchanged behaviour.
    IF EXISTS (SELECT 1 FROM sms_messages WHERE provider_message_id = v_mid OR provider_dlr_message_id = v_mid) THEN
      IF v_state NOT IN ('delivered','failed') THEN
        UPDATE sms_messages SET cost_ghs = COALESCE(v_rate, cost_ghs)
        WHERE (provider_message_id = v_mid OR provider_dlr_message_id = v_mid) AND delivery_status = 'pending';
        CONTINUE;
      END IF;
      FOR m IN SELECT id, send_log_id FROM sms_messages
               WHERE (provider_message_id = v_mid OR provider_dlr_message_id = v_mid) AND delivery_status = 'pending' FOR UPDATE LOOP
        UPDATE sms_messages
        SET delivery_status = v_state,
            delivered_at = CASE WHEN v_state = 'delivered' THEN COALESCE(v_at, now()) END,
            cost_ghs = COALESCE(v_rate, cost_ghs)
        WHERE id = m.id;
        out_message_id := m.id;
        out_send_log_id := m.send_log_id;
        out_outcome := v_state;
        out_refunded := CASE WHEN v_state = 'failed' THEN refund_sms_message(m.id) ELSE false END;
        RETURN NEXT;
      END LOOP;
      CONTINUE;
    END IF;

    -- 2. Batch + recipient: the earliest still-unmatched pending row of this batch for this phone.
    CONTINUE WHEN v_bid IS NULL OR v_to IS NULL;
    v_id := NULL;
    SELECT id, send_log_id INTO v_id, v_send_log_id
    FROM sms_messages
    WHERE provider_batch_id = v_bid
      AND provider = 'hubtel' AND status = 'sent' AND delivery_status = 'pending'
      AND provider_dlr_message_id IS NULL
      AND id <> ALL (v_used)
      AND (provider_message_id IS NULL OR provider_message_id <> ALL (v_mids))
      AND right(regexp_replace(phone, '\D', '', 'g'), 9) = right(v_to, 9)
    ORDER BY created_at, id LIMIT 1 FOR UPDATE;
    CONTINUE WHEN v_id IS NULL;
    v_used := v_used || v_id;

    IF v_state NOT IN ('delivered','failed') THEN
      -- Not final: record cost only, and do not bind (the report id is bound when it settles).
      UPDATE sms_messages SET cost_ghs = COALESCE(v_rate, cost_ghs)
      WHERE id = v_id AND delivery_status = 'pending';
      CONTINUE;
    END IF;

    UPDATE sms_messages
    SET provider_dlr_message_id = v_mid,
        delivery_status = v_state,
        delivered_at = CASE WHEN v_state = 'delivered' THEN COALESCE(v_at, now()) END,
        cost_ghs = COALESCE(v_rate, cost_ghs)
    WHERE id = v_id AND delivery_status = 'pending' AND provider_dlr_message_id IS NULL;
    CONTINUE WHEN NOT FOUND;
    out_message_id := v_id;
    out_send_log_id := v_send_log_id;
    out_outcome := v_state;
    out_refunded := CASE WHEN v_state = 'failed' THEN refund_sms_message(v_id) ELSE false END;
    RETURN NEXT;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION apply_sms_delivery_reports(JSONB)     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION apply_sms_delivery_reports(JSONB) TO service_role;

COMMIT;
