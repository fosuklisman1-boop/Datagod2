-- Add ordering_enabled to app_settings table
ALTER TABLE app_settings 
ADD COLUMN IF NOT EXISTS ordering_enabled BOOLEAN DEFAULT TRUE;

-- Update the comment
COMMENT ON COLUMN app_settings.ordering_enabled IS 'Global switch to enable/disable order placement';
