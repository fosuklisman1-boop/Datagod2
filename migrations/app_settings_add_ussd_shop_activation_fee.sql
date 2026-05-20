ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS ussd_shop_activation_fee DECIMAL(10,2) NOT NULL DEFAULT 0;
