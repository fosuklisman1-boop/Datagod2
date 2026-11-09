-- 0157_hubtel_payments_refunded_manually.sql
--
-- A customer's second Hubtel payment on an already paid order parks in needs_review with no exit, and while it is parked
-- the order's first payment can't be refunded either. An admin pays the customer back by hand, then records it with the
-- "Refunded outside the app" action (lib/hubtel-pay/review.ts), which moves no money.
--
--   status         adds the terminal value 'refunded_manually'. Nothing claims, re-checks or fulfils such a row.
--   manual_refund  what the admin recorded: { admin_reference, note, admin_id, recorded_at }. The note is free text, so it
--                  stays on this table (no anon/authenticated access, 0151) and is never logged or sent to the audit log.
--
-- Additive and idempotent: NOT VALID then VALIDATE, so the table is not scanned under the exclusive lock.
--
-- ORDER: either side of the deploy. Until it is applied, using the action fails with an error and changes nothing: the
-- write is one UPDATE, and the wallet row is only closed after it lands. The review list doesn't read the new column.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.hubtel_payments ADD COLUMN IF NOT EXISTS manual_refund jsonb;

ALTER TABLE public.hubtel_payments DROP CONSTRAINT IF EXISTS hubtel_payments_status_check;
ALTER TABLE public.hubtel_payments ADD CONSTRAINT hubtel_payments_status_check
  CHECK (status IN ('pending', 'confirming', 'paid', 'failed', 'needs_review', 'refunded_manually')) NOT VALID;

COMMIT;

ALTER TABLE public.hubtel_payments VALIDATE CONSTRAINT hubtel_payments_status_check;

NOTIFY pgrst, 'reload schema';
