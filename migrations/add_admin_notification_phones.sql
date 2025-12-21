-- Add admin notification phone numbers setting
-- Run this after add_admin_settings.sql

-- Insert admin notification phones setting (update the phone numbers as needed)
INSERT INTO admin_settings (key, value)
VALUES (
  'admin_notification_phones', 
  '{"phones": [], "description": "Admin phone numbers for SMS notifications on fulfillment failures"}'
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = NOW();

-- Example with phone numbers:
-- UPDATE admin_settings 
-- SET value = '{"phones": ["0551234567", "0241234567"]}'
-- WHERE key = 'admin_notification_phones';
