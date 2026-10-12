-- 0112_hubtel_ussd_sessions.sql
-- Hubtel USSD session state, one row per Hubtel SessionId. Replaces Redis as the primary session
-- store (lib/ussd-hubtel/session.ts dbSessionStore): every serverless instance sees the same row,
-- so a failing Redis no longer causes intermittent "Session expired".
--
-- Apply BEFORE the deploy that makes it the only store: without the table every read is a miss and
-- sessions survive only through the signed ClientState snapshot. Rows past expires_at are ignored
-- and purged opportunistically.

CREATE TABLE IF NOT EXISTS hubtel_ussd_sessions (
  session_id  text PRIMARY KEY,
  data        jsonb NOT NULL,
  expires_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hubtel_ussd_sessions_expires_at ON hubtel_ussd_sessions (expires_at);

ALTER TABLE hubtel_ussd_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_ussd_sessions FROM anon, authenticated;
