-- Add 'ussd' (and other already-used types) to the payment_type CHECK constraint
-- on payment_attempts. The original constraint only allowed 'wallet_topup' and
-- 'shop_order', causing silent failures for USSD charge records.

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_payment_type_check;

ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_payment_type_check
  CHECK (payment_type IN ('wallet_topup', 'shop_order', 'shop_airtime', 'airtime', 'results_checker', 'ussd'));
