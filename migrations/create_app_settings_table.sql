-- Create app_settings table
CREATE TABLE IF NOT EXISTS app_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  join_community_link VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS (but allow public to read, only admins to write)
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Anyone can view settings
CREATE POLICY "Anyone can view app settings" ON app_settings
  FOR SELECT
  USING (true);

-- Only service role can update (admins go through API which verifies)
CREATE POLICY "Service role can update settings" ON app_settings
  FOR UPDATE
  WITH CHECK (true);

-- Only service role can insert
CREATE POLICY "Service role can insert settings" ON app_settings
  FOR INSERT
  WITH CHECK (true);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_app_settings_id ON app_settings(id);

-- Grant permissions
GRANT SELECT ON app_settings TO anon, authenticated;
GRANT ALL ON app_settings TO service_role;
