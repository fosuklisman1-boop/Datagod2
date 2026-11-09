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
--     internal_reference  the reference the shared charge handler looks the payment up by (e.g. a surface's own
--                    order id). NULL means the opaque reference itself. Never sent to Hubtel.
--     metadata       what the shared charge handler would get as Paystack metadata; Hubtel returns none.
--     handler_amount_pesewas  what the shared charge handler is told was paid, when that differs from the amount
--                    requested from Hubtel (the merchant bears the fee: less is requested, the handler checks the
--                    full price). NULL means amount_pesewas.
--     refused_at     set when Hubtel never got the request (refused, or a start error before sending). Such a row
--                    has nothing to check, so it is never status-checked again.
--
--   hubtel_payments_one_open_per_order  at most one pending/confirming row per internal_reference, so it guards
--                    starts that reuse the same reference only: a caller minting a new reference per attempt is not
--                    covered. Paid and needs_review rows stay outside it on purpose, because a failed -> needs_review
--                    late payment must be able to land beside a paid or open attempt.
--
-- Security: RLS enabled with NO policies, and all privileges revoked from anon/authenticated (0060 grants
-- authenticated CRUD on all tables by default). Only server routes using the service role touch it.

CREATE TABLE IF NOT EXISTS public.hubtel_payments (
  reference             text PRIMARY KEY CHECK (reference ~ '^[0-9a-f]{32}$'),
  internal_reference    text,
  metadata              jsonb,
  surface               text NOT NULL,
  mode                 text NOT NULL CHECK (mode IN ('checkout', 'direct')),
  amount_pesewas        integer NOT NULL CHECK (amount_pesewas > 0),
  handler_amount_pesewas integer CHECK (handler_amount_pesewas > 0),
  refused_at            timestamptz,
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

CREATE UNIQUE INDEX IF NOT EXISTS hubtel_payments_one_open_per_order
  ON public.hubtel_payments (internal_reference)
  WHERE internal_reference IS NOT NULL AND status IN ('pending', 'confirming');

ALTER TABLE public.hubtel_payments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.hubtel_payments FROM anon, authenticated;
