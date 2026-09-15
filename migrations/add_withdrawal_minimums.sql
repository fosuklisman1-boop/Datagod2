ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS withdrawal_fee_minimum numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minimum_withdrawal_amount numeric NOT NULL DEFAULT 5;
