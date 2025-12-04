-- Add announcement fields to app_settings table
-- Run this SQL in your Supabase SQL Editor

ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS announcement_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS announcement_title TEXT DEFAULT '',
ADD COLUMN IF NOT EXISTS announcement_message TEXT DEFAULT '';

-- Add comment to columns
COMMENT ON COLUMN app_settings.announcement_enabled IS 'Whether to show announcement modal on login';
COMMENT ON COLUMN app_settings.announcement_title IS 'Title of the announcement modal';
COMMENT ON COLUMN app_settings.announcement_message IS 'Message content of the announcement modal';
