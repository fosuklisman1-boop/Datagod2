-- Create shop_settings table
CREATE TABLE IF NOT EXISTS shop_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL UNIQUE REFERENCES user_shops(id) ON DELETE CASCADE,
  whatsapp_link VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE shop_settings ENABLE ROW LEVEL SECURITY;

-- Anyone can view shop settings (public storefront)
DROP POLICY IF EXISTS "Anyone can view shop settings" ON shop_settings;
CREATE POLICY "Anyone can view shop settings" ON shop_settings
  FOR SELECT
  USING (true);

-- Only shop owner can update
DROP POLICY IF EXISTS "Shop owner can update settings" ON shop_settings;
CREATE POLICY "Shop owner can update settings" ON shop_settings
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_settings.shop_id AND user_shops.user_id = auth.uid()
    )
  );

-- Only shop owner can insert
DROP POLICY IF EXISTS "Shop owner can insert settings" ON shop_settings;
CREATE POLICY "Shop owner can insert settings" ON shop_settings
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_settings.shop_id AND user_shops.user_id = auth.uid()
    )
  );

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_shop_settings_shop_id ON shop_settings(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_settings_updated_at ON shop_settings(updated_at);

-- Grant permissions
GRANT SELECT ON shop_settings TO anon, authenticated;
