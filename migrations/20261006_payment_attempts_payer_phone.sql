-- Record the PAYER's MoMo number for storefront direct-charge payments so refund payout gateways
-- (Moolre / Paystack payout) know where to send money. Nullable; only set on the direct MoMo path.
-- Safe to apply before or after the order-refunds migration; app code degrades if it is not applied yet.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.payment_attempts ADD COLUMN IF NOT EXISTS payer_phone text;
COMMIT;
