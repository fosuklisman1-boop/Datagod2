-- 0153_hubtel_payments_internal_reference_idx.sql
--
-- Payment gateway plan 4, task 8. ADDITIVE. Idempotent (re-runnable). Requires 0151.
--
--   hubtel_payments_internal_reference_idx  a plain index on internal_reference. 0151's unique index
--     (hubtel_payments_one_open_per_order) is partial, covering pending/confirming rows only, so lookups across all
--     statuses (paid-sibling checks, lib/hubtel-pay/lookup.ts, the Paystack verifiers, refunds) scan without this.
--
-- Plain CREATE INDEX, as the table is small before go-live and the migration may run inside a transaction. If this
-- runs after Hubtel has real volume, run the CREATE INDEX CONCURRENTLY form instead, outside a transaction.

CREATE INDEX IF NOT EXISTS hubtel_payments_internal_reference_idx
  ON public.hubtel_payments (internal_reference);
