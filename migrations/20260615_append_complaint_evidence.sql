-- Atomic evidence append for WhatsApp complaints. The previous read-modify-write
-- in JS could lose an image if two of a sender's uploads were processed
-- concurrently (Next.js after() across workers). This appends in one statement
-- and enforces the 10-screenshot cap server-side. Returns rows affected (1 =
-- appended, 0 = capped or complaint missing).
CREATE OR REPLACE FUNCTION append_complaint_evidence(p_id uuid, p_url text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE whatsapp_complaints
  SET evidence_urls = evidence_urls || to_jsonb(p_url),
      updated_at = now()
  WHERE id = p_id
    AND jsonb_array_length(evidence_urls) < 10;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION append_complaint_evidence(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_complaint_evidence(uuid, text) TO service_role;
