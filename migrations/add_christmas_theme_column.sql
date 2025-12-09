-- Add christmas_theme_enabled column to app_settings table
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS christmas_theme_enabled BOOLEAN DEFAULT FALSE;
