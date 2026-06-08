-- USSD Airtime + Results Checker support
-- Reuses the existing airtime_orders / results_checker_orders tables for USSD
-- orders (main *code# menu and white-label shop menu). Adds the USSD-specific
-- columns the storefront never needed:
--   • dialing_phone — the USSD payer's number (distinct from beneficiary/customer
--     phone). Used to find a caller's pending OTP order on redial, and to SMS the
--     payer on completion.
--   • channel — 'ussd' (main) | 'ussd_shop' (white-label). Web orders leave it NULL.
-- Also allows payment_status = 'otp_required' on results_checker_orders so the
-- OTP-redial flow can park an order between dial sessions (mirrors ussd_orders).
-- airtime_orders.payment_status has no CHECK constraint, so it already accepts it.

-- ── airtime_orders ────────────────────────────────────────────────────────────
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS dialing_phone TEXT;
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS channel TEXT;

CREATE INDEX IF NOT EXISTS idx_airtime_orders_dialing_otp
  ON public.airtime_orders (dialing_phone, payment_status);

-- ── results_checker_orders ────────────────────────────────────────────────────
ALTER TABLE public.results_checker_orders ADD COLUMN IF NOT EXISTS dialing_phone TEXT;
ALTER TABLE public.results_checker_orders ADD COLUMN IF NOT EXISTS channel TEXT;

-- Relax the payment_status CHECK to permit 'otp_required'
ALTER TABLE public.results_checker_orders
  DROP CONSTRAINT IF EXISTS results_checker_orders_payment_status_check;
ALTER TABLE public.results_checker_orders
  ADD CONSTRAINT results_checker_orders_payment_status_check
  CHECK (payment_status IN ('pending', 'pending_payment', 'completed', 'failed', 'otp_required'));

CREATE INDEX IF NOT EXISTS idx_rco_dialing_otp
  ON public.results_checker_orders (dialing_phone, payment_status);
