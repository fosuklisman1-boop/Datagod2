ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS ussd_shop_dial_code VARCHAR(20);
