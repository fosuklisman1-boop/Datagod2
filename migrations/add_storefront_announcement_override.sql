-- Add storefront announcement override fields to app_settings table
-- These fields allow for a global announcement that appears across ALL storefronts

ALTER TABLE app_settings 
ADD COLUMN IF NOT EXISTS storefront_announcement_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS storefront_announcement_title TEXT DEFAULT '',
ADD COLUMN IF NOT EXISTS storefront_announcement_message TEXT DEFAULT '';

-- Add comments for documentation
COMMENT ON COLUMN app_settings.storefront_announcement_enabled IS 'Global override to show announcement on ALL storefronts';
COMMENT ON COLUMN app_settings.storefront_announcement_title IS 'Title for the global storefront override announcement';
COMMENT ON COLUMN app_settings.storefront_announcement_message IS 'Message for the global storefront override announcement';

-- Ensure the single settings row has these initialized
UPDATE app_settings 
SET 
  storefront_announcement_enabled = COALESCE(storefront_announcement_enabled, false),
  storefront_announcement_title = COALESCE(storefront_announcement_title, ''),
  storefront_announcement_message = COALESCE(storefront_announcement_message, '')
WHERE id = (SELECT id FROM app_settings LIMIT 1);
