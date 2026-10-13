-- 0114_hubtel_cs_events.sql
-- Audit trail per Hubtel Commission Services call. ADDITIVE; the app logs best-effort and stays
-- silent (one warning per process) until this table exists. Service-role only. Retention 30 days
-- (purged by the hubtel-cs-status-check cron). Payloads never contain credentials or callback signatures.

CREATE TABLE IF NOT EXISTS hubtel_cs_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  client_reference text,
  direction        text NOT NULL CHECK (direction IN ('request','response','callback','status_check')),
  http_status      int,
  ok               boolean,
  payload          jsonb,
  error            text,
  source_ip        text
);

CREATE INDEX IF NOT EXISTS hubtel_cs_events_ref_idx ON hubtel_cs_events (client_reference, created_at DESC);
CREATE INDEX IF NOT EXISTS hubtel_cs_events_created_idx ON hubtel_cs_events (created_at DESC);

ALTER TABLE hubtel_cs_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_cs_events FROM anon, authenticated;
