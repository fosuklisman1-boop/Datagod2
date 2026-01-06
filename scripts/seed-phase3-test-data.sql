-- Insert test users
INSERT INTO users (email, created_at) VALUES
  ('test-admin@datagod.com', NOW()),
  ('test-customer@datagod.com', NOW());

-- Insert test shop
INSERT INTO shops (name, email, user_id) VALUES
  ('Test Shop', 'test-shop@datagod.com',
   (SELECT id FROM users WHERE email = 'test-admin@datagod.com' LIMIT 1));

-- Insert test settings
INSERT INTO app_settings (setting_name, setting_value, updated_at) VALUES
  ('mtn_auto_fulfillment_enabled', 'true', NOW())
ON CONFLICT (setting_name) DO UPDATE SET
  setting_value = 'true',
  updated_at = NOW();

-- Verify data
SELECT 'Test data inserted successfully';
