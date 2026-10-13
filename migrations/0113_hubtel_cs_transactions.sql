-- 0113_hubtel_cs_transactions.sql
-- Hubtel Commission Services ledger: one row per POST to cs.hubtel.com (airtime, data, bills).
-- ADDITIVE; service-role only (RLS on, no policies, no grants to anon/authenticated), like 0106.

CREATE TABLE IF NOT EXISTS hubtel_cs_transactions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_reference        text NOT NULL UNIQUE CHECK (client_reference ~ '^[A-Za-z0-9_-]{1,100}$'),
  service_key             text NOT NULL,
  kind                    text NOT NULL CHECK (kind IN ('airtime','data','bill')),
  destination             text NOT NULL,
  amount                  numeric(12,2) NOT NULL CHECK (amount > 0),
  bundle                  text,
  extra                   jsonb,
  state                   text NOT NULL DEFAULT 'created'
                            CHECK (state IN ('created','pending','fulfilled','failed','needs_review')),
  response_code           text,
  response_message        text,
  failure_reason          text,
  hubtel_transaction_id   text,
  external_transaction_id text,
  commission              numeric(12,6),
  charges                 numeric(12,4),
  amount_debited          numeric(12,2),
  order_table             text,
  order_id                uuid,
  submitted_at            timestamptz,
  completed_at            timestamptz,
  callback_received_at    timestamptz,
  status_check_attempts   int NOT NULL DEFAULT 0,
  negative_checks         int NOT NULL DEFAULT 0,
  last_status_check_at    timestamptz,
  review_reason           text,
  resolved_by             uuid,
  resolved_at             timestamptz,
  resolution_note         text,
  refund_claimed_at       timestamptz,
  refund_claimed_by       uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hubtel_cs_tx_open_idx
  ON hubtel_cs_transactions (state, created_at) WHERE state IN ('created','pending','needs_review');
CREATE INDEX IF NOT EXISTS hubtel_cs_tx_order_idx
  ON hubtel_cs_transactions (order_table, order_id);
CREATE UNIQUE INDEX IF NOT EXISTS hubtel_cs_tx_order_active_uidx
  ON hubtel_cs_transactions (order_table, order_id)
  WHERE order_id IS NOT NULL AND state <> 'failed';
CREATE INDEX IF NOT EXISTS hubtel_cs_tx_created_idx
  ON hubtel_cs_transactions (created_at DESC);

ALTER TABLE hubtel_cs_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_cs_transactions FROM anon, authenticated;

-- Aggregates in SQL (PostgREST caps selects at 1000 rows, so never sum in app code).
CREATE OR REPLACE FUNCTION hubtel_cs_stats()
RETURNS TABLE (total bigint, in_flight bigint, needs_review bigint, failed bigint, fulfilled bigint, commission_earned numeric)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT count(*),
         count(*) FILTER (WHERE state IN ('created','pending')),
         count(*) FILTER (WHERE state = 'needs_review'),
         count(*) FILTER (WHERE state = 'failed'),
         count(*) FILTER (WHERE state = 'fulfilled'),
         COALESCE(sum(commission) FILTER (WHERE state = 'fulfilled'), 0)
  FROM hubtel_cs_transactions
$$;
REVOKE ALL ON FUNCTION hubtel_cs_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hubtel_cs_stats() TO service_role;
