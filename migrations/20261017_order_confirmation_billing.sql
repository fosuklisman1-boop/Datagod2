-- Phase 4b / Task 7: billed order confirmations.
--  1. shop_settings.order_confirmation_use_own_sender (default false = free platform sender).
--  2. sms_order_confirmations: per-order idempotency guard. The confirmation sender inserts the row
--     FIRST (ON CONFLICT DO NOTHING); a conflict means the order was already handled, so a retried
--     fulfilment can never double-bill or double-send. shop_order_id is UUID to match shop_orders.id.
-- Service-role only: RLS on with no policies, all privileges revoked from public roles.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE shop_settings
  ADD COLUMN IF NOT EXISTS order_confirmation_use_own_sender BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS sms_order_confirmations (
  shop_order_id UUID PRIMARY KEY,
  shop_id UUID,
  sms_account_id UUID,
  mode TEXT NOT NULL CHECK (mode IN ('billed', 'free')),
  send_log_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sms_order_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sms_order_confirmations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sms_order_confirmations TO service_role;

COMMIT;
