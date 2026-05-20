-- Add USSD price tier setting to app_settings
-- Allows admin to toggle whether USSD purchases use regular or dealer pricing.
-- Falls back to regular price when dealer_price is null/0 regardless of this setting.

ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS ussd_price_tier VARCHAR(20) NOT NULL DEFAULT 'regular';

-- Ensure existing rows get the default
UPDATE app_settings SET ussd_price_tier = 'regular' WHERE ussd_price_tier IS NULL;
