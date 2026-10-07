-- 0106_hubtel_ussd.sql
-- Hubtel Programmable Services payment lifecycle. One row per Hubtel session
-- that reached AddToCart. Service-role only (no grants to anon/authenticated).

CREATE TABLE IF NOT EXISTS hubtel_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            text NOT NULL UNIQUE,
  hubtel_order_id       text,
  platform              text NOT NULL DEFAULT 'USSD',
  order_table           text NOT NULL CHECK (order_table IN (
                          'ussd_orders','ussd_shop_orders','airtime_orders',
                          'results_checker_orders','results_check_requests','ussd_afa_orders')),
  order_id              uuid NOT NULL,
  mobile                text,
  expected_amount       numeric(10,2) NOT NULL,
  amount_paid           numeric(10,2),
  amount_after_charges  numeric(10,2),
  state                 text NOT NULL DEFAULT 'awaiting_payment' CHECK (state IN (
                          'awaiting_payment','processing','fulfilled','needs_review','failed')),
  callback_status       text NOT NULL DEFAULT 'not_due' CHECK (callback_status IN (
                          'not_due','pending','sent','failed')),
  callback_attempts     int  NOT NULL DEFAULT 0,
  callback_last_error   text,
  callback_sent_at      timestamptz,
  status_check_attempts int  NOT NULL DEFAULT 0,
  last_status_check_at  timestamptz,
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hubtel_transactions_callback_idx
  ON hubtel_transactions (callback_status) WHERE callback_status = 'pending';
CREATE INDEX IF NOT EXISTS hubtel_transactions_awaiting_idx
  ON hubtel_transactions (created_at) WHERE state = 'awaiting_payment';
CREATE INDEX IF NOT EXISTS hubtel_transactions_order_idx
  ON hubtel_transactions (order_table, order_id);

ALTER TABLE hubtel_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_transactions FROM anon, authenticated;
-- No policies on purpose: only the service role (which bypasses RLS) may touch this table.
