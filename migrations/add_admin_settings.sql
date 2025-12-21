-- Add admin_settings table for storing admin configuration
-- This table stores key-value pairs for various admin settings

CREATE TABLE IF NOT EXISTS admin_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key VARCHAR(100) UNIQUE NOT NULL,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

-- Create index on key for fast lookups
CREATE INDEX IF NOT EXISTS idx_admin_settings_key ON admin_settings(key);

-- Insert default auto-fulfillment setting (enabled by default)
INSERT INTO admin_settings (key, value, description)
VALUES (
  'auto_fulfillment_enabled',
  '{"enabled": true, "networks": ["AT - iShare", "Telecel"]}',
  'Controls whether AT-iShare and Telecel orders are auto-fulfilled via Code Craft API or sent to admin queue'
)
ON CONFLICT (key) DO NOTHING;

-- Enable RLS
ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;

-- Policy: Only admins can read settings
CREATE POLICY "Admins can read settings" ON admin_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
      AND auth.users.raw_user_meta_data->>'role' = 'admin'
    )
  );

-- Policy: Only admins can update settings
CREATE POLICY "Admins can update settings" ON admin_settings
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
      AND auth.users.raw_user_meta_data->>'role' = 'admin'
    )
  );

-- Policy: Only admins can insert settings
CREATE POLICY "Admins can insert settings" ON admin_settings
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
      AND auth.users.raw_user_meta_data->>'role' = 'admin'
    )
  );

-- Grant service role full access (for API routes)
GRANT ALL ON admin_settings TO service_role;
