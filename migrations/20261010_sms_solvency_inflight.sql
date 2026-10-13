-- Solvency gate (spec §5.5a): units leave unit_balance when a send is queued, but the
-- provider float is only spent at dispatch. Until then the same money backs both the queued
-- units and any new purchase. sms_queued_unsent_units() lets the gate subtract that backlog.
-- Also: make the 7-day max-rate lookup an index-only scan (it runs on every purchase).
BEGIN;

CREATE OR REPLACE FUNCTION sms_queued_unsent_units()
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(sum(segments), 0)::bigint
  FROM sms_messages
  WHERE NOT refunded
    AND (status IN ('pending', 'claimed') OR (status = 'failed' AND attempts < 3));
$$;

REVOKE ALL ON FUNCTION sms_queued_unsent_units() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_queued_unsent_units() TO service_role;

-- Backlog scan support: only the small unsent set is indexed.
CREATE INDEX IF NOT EXISTS idx_sms_messages_unsent
  ON sms_messages(status) WHERE NOT refunded AND status IN ('pending', 'claimed', 'failed');

DROP INDEX IF EXISTS idx_sms_messages_hubtel_rate;
CREATE INDEX idx_sms_messages_hubtel_rate
  ON sms_messages(processed_at) INCLUDE (cost_ghs)
  WHERE provider = 'hubtel' AND cost_ghs IS NOT NULL;

COMMIT;
