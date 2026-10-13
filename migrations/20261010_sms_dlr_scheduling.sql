-- Hubtel DLR polling: fair scheduling + race-safe 72 h close (spec §5.5).
-- * dlr_checked_at lets the poller round-robin batches/singles so batches whose last
--   recipients never get a final DLR can't starve newer ones (which would then be
--   refunded at 72 h even if delivered).
-- * close_stale_sms_deliveries locks and re-checks rows inside the transaction, so a late
--   "delivered" report applied concurrently is never overwritten by a refund.
BEGIN;

ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS dlr_checked_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION pick_sms_dlr_batches(p_ready_before TIMESTAMPTZ, p_give_up_before TIMESTAMPTZ, p_limit INT)
RETURNS TABLE(provider_batch_id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.provider_batch_id
  FROM sms_messages m
  WHERE m.provider = 'hubtel' AND m.status = 'sent' AND m.delivery_status = 'pending'
    AND m.provider_batch_id IS NOT NULL
    AND m.processed_at <= p_ready_before AND m.processed_at >= p_give_up_before
  GROUP BY m.provider_batch_id
  ORDER BY max(m.dlr_checked_at) NULLS FIRST, min(m.processed_at)
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION pick_sms_dlr_singles(p_ready_before TIMESTAMPTZ, p_give_up_before TIMESTAMPTZ, p_limit INT)
RETURNS TABLE(provider_message_id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.provider_message_id
  FROM sms_messages m
  WHERE m.provider = 'hubtel' AND m.status = 'sent' AND m.delivery_status = 'pending'
    AND m.provider_batch_id IS NULL AND m.provider_message_id IS NOT NULL
    AND m.processed_at <= p_ready_before AND m.processed_at >= p_give_up_before
  ORDER BY m.dlr_checked_at NULLS FIRST, m.processed_at
  LIMIT p_limit;
$$;

-- Stamp everything just polled (success or failure) so the next run moves on.
CREATE OR REPLACE FUNCTION mark_sms_dlr_checked(p_batch_ids TEXT[], p_message_ids TEXT[])
RETURNS INT
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH u AS (
    UPDATE sms_messages SET dlr_checked_at = now()
    WHERE delivery_status = 'pending'
      AND (provider_batch_id = ANY(COALESCE(p_batch_ids, '{}')) OR provider_message_id = ANY(COALESCE(p_message_ids, '{}')))
    RETURNING 1
  )
  SELECT count(*)::int FROM u;
$$;

-- Close still-pending Hubtel messages older than p_before as failed and refund each once.
-- Rows are locked (SKIP LOCKED) and re-checked, so a concurrent DLR apply wins cleanly.
CREATE OR REPLACE FUNCTION close_stale_sms_deliveries(p_before TIMESTAMPTZ, p_limit INT)
RETURNS TABLE(out_message_id UUID, out_send_log_id BIGINT, out_refunded BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m RECORD;
BEGIN
  FOR m IN
    SELECT id, send_log_id FROM sms_messages
    WHERE provider = 'hubtel' AND status = 'sent' AND delivery_status = 'pending' AND processed_at < p_before
    ORDER BY processed_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    out_message_id := m.id;
    out_send_log_id := m.send_log_id;
    out_refunded := refund_sms_message(m.id);
    RETURN NEXT;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION pick_sms_dlr_batches(TIMESTAMPTZ, TIMESTAMPTZ, INT)     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION pick_sms_dlr_batches(TIMESTAMPTZ, TIMESTAMPTZ, INT) TO service_role;
REVOKE ALL ON FUNCTION pick_sms_dlr_singles(TIMESTAMPTZ, TIMESTAMPTZ, INT)     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION pick_sms_dlr_singles(TIMESTAMPTZ, TIMESTAMPTZ, INT) TO service_role;
REVOKE ALL ON FUNCTION mark_sms_dlr_checked(TEXT[], TEXT[])                    FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mark_sms_dlr_checked(TEXT[], TEXT[])                TO service_role;
REVOKE ALL ON FUNCTION close_stale_sms_deliveries(TIMESTAMPTZ, INT)            FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION close_stale_sms_deliveries(TIMESTAMPTZ, INT)        TO service_role;

COMMIT;
