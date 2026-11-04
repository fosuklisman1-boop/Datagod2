-- 0151_hubtel_payments.sql
--
-- Hubtel collection core (payment gateway plan 3, task 1). ADDITIVE. Idempotent (re-runnable). Nothing reads or
-- writes this table yet.
--
--   hubtel_payments  one row per Hubtel collection attempt (checkout link or direct MoMo debit).
--     reference      OPAQUE: exactly 32 lowercase hex chars (lib/hubtel-pay/reference.ts). Owner rule: never a
--                    surface or product word (no "WALLET-" etc.); the CHECK enforces the shape at the DB.
--     surface        which Datagod surface started the payment (internal only, never sent to Hubtel).
--     mode           'checkout' (hosted link) or 'direct' (direct receive money).
--     amount_pesewas integer, > 0.
--     status         pending -> confirming (claimed) -> paid | failed | needs_review.
--     last_check     the latest Hubtel status-check payload; claimed_at marks the confirming claim.
--
-- Security: RLS enabled with NO policies, and all privileges revoked from anon/authenticated (0060 grants
-- authenticated CRUD on all tables by default). Only server routes using the service role touch it.

CREATE TABLE IF NOT EXISTS public.hubtel_payments (
  reference             text PRIMARY KEY CHECK (reference ~ '^[0-9a-f]{32}$'),
  surface               text NOT NULL,
  mode                  text NOT NULL CHECK (mode IN ('checkout', 'direct')),
  amount_pesewas        integer NOT NULL CHECK (amount_pesewas > 0),
  msisdn                text,
  channel               text,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'confirming', 'paid', 'failed', 'needs_review')),
  hubtel_transaction_id text,
  charges_pesewas       integer,
  payment_method        text,
  checkout_url          text,
  last_check            jsonb,
  claimed_at            timestamptz,
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hubtel_payments_status_created_idx
  ON public.hubtel_payments (status, created_at);

ALTER TABLE public.hubtel_payments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.hubtel_payments FROM anon, authenticated;
