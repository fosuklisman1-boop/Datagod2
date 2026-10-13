-- Keep mark_sms_dlr_checked off a full-table scan: restrict it to the in-flight Hubtel set
-- (matches idx_sms_messages_dlr_pending's predicate) and index provider_batch_id.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_sms_messages_provider_batch
  ON sms_messages(provider_batch_id) WHERE provider_batch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mark_sms_dlr_checked(p_batch_ids TEXT[], p_message_ids TEXT[])
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batches INT := 0;
  v_singles INT := 0;
BEGIN
  IF COALESCE(array_length(p_batch_ids, 1), 0) > 0 THEN
    UPDATE sms_messages SET dlr_checked_at = now()
    WHERE provider = 'hubtel' AND status = 'sent' AND delivery_status = 'pending'
      AND provider_batch_id = ANY(p_batch_ids);
    GET DIAGNOSTICS v_batches = ROW_COUNT;
  END IF;
  IF COALESCE(array_length(p_message_ids, 1), 0) > 0 THEN
    UPDATE sms_messages SET dlr_checked_at = now()
    WHERE provider = 'hubtel' AND status = 'sent' AND delivery_status = 'pending'
      AND provider_message_id = ANY(p_message_ids);
    GET DIAGNOSTICS v_singles = ROW_COUNT;
  END IF;
  RETURN v_batches + v_singles;
END $$;

REVOKE ALL ON FUNCTION mark_sms_dlr_checked(TEXT[], TEXT[])     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mark_sms_dlr_checked(TEXT[], TEXT[]) TO service_role;

COMMIT;
