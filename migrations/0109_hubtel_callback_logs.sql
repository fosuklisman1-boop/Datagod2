-- 0109_hubtel_callback_logs.sql
-- Hubtel callback log: one row per inbound fulfilment webhook (Hubtel -> us, authenticated
-- requests only) and per outbound success-callback attempt (us -> relay -> Hubtel).
--
-- ADDITIVE and safe to apply before or after the deploy that writes to it: the app logs
-- best-effort and stays silent (one warning per process) until this table exists.
-- Payloads contain customer name / phone: service-role only, same lockdown as
-- hubtel_transactions in 0106 (RLS on, no policies, no grants to anon/authenticated).
-- Retention: the hubtel-callbacks cron deletes rows older than 30 days.

CREATE TABLE IF NOT EXISTS hubtel_callback_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  direction        text NOT NULL CHECK (direction IN ('inbound_fulfillment', 'outbound_callback')),
  session_id       text,
  hubtel_order_id  text,
  outcome          text,
  ok               boolean,
  http_status      int,
  payload          jsonb,
  raw_body         text,
  response         jsonb,
  error            text,
  source_ip        text
);

CREATE INDEX IF NOT EXISTS idx_hubtel_callback_logs_created_at ON hubtel_callback_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hubtel_callback_logs_session_id ON hubtel_callback_logs (session_id);
CREATE INDEX IF NOT EXISTS idx_hubtel_callback_logs_problems ON hubtel_callback_logs (created_at DESC) WHERE ok = false;

ALTER TABLE hubtel_callback_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_callback_logs FROM anon, authenticated;
