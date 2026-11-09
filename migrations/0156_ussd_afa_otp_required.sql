-- 0156_ussd_afa_otp_required.sql
-- A USSD AFA order whose Paystack charge asks for an OTP now waits at payment_status 'otp_required', as bundles do, so a
-- redial can find it. Production's CHECK allows only pending/completed/failed, so that write would be refused.
-- Additive: widens the allowed values. NOT VALID then VALIDATE, so the table is not scanned under the exclusive lock.
--
-- ORDER: apply this before deploying the code that writes otp_required. If the code runs first, the write is refused,
-- the code logs it and sends no SMS, and the order behaves as it does today.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.ussd_afa_orders DROP CONSTRAINT IF EXISTS ussd_afa_orders_payment_status_check;
ALTER TABLE public.ussd_afa_orders ADD CONSTRAINT ussd_afa_orders_payment_status_check
  CHECK (payment_status IN ('pending','completed','failed','otp_required')) NOT VALID;

COMMIT;

ALTER TABLE public.ussd_afa_orders VALIDATE CONSTRAINT ussd_afa_orders_payment_status_check;
