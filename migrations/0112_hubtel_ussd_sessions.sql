-- 0112_hubtel_ussd_sessions.sql
-- Hubtel USSD session state, one row per Hubtel SessionId. Replaces Redis as the primary session
-- store (lib/ussd-hubtel/session.ts dbSessionStore): every serverless instance sees the same row,
-- so a failing Redis no longer causes intermittent "Session expired".
--
-- Safe to apply before or after the deploy: until the table exists every read/write errors and the
-- code falls back to the previous Redis / in-process store. Rows past expires_at are ignored and
-- purged opportunistically on new dials.

CREATE TABLE IF NOT EXISTS hubtel_ussd_sessions (
  session_id  text PRIMARY KEY,
  data        jsonb NOT NULL,
  expires_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hubtel_ussd_sessions_expires_at ON hubtel_ussd_sessions (expires_at);

ALTER TABLE hubtel_ussd_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_ussd_sessions FROM anon, authenticated;
