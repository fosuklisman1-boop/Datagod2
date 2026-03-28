-- Migration: Add feature availability toggles to app_settings

-- 1. Add boolean columns for individual feature toggles, defaulting to true (enabled)
ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS signups_enabled BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS wallet_topups_enabled BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS upgrades_enabled BOOLEAN DEFAULT true;

-- 2. Ensure they are NOT NULL after applying the default (for consistency)
UPDATE app_settings
SET 
  signups_enabled = true 
WHERE signups_enabled IS NULL;

UPDATE app_settings
SET 
  wallet_topups_enabled = true 
WHERE wallet_topups_enabled IS NULL;

UPDATE app_settings
SET 
  upgrades_enabled = true 
WHERE upgrades_enabled IS NULL;

ALTER TABLE app_settings 
ALTER COLUMN signups_enabled SET NOT NULL,
ALTER COLUMN wallet_topups_enabled SET NOT NULL,
ALTER COLUMN upgrades_enabled SET NOT NULL;
