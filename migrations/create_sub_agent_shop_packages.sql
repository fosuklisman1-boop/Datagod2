-- Create sub_agent_shop_packages table for sub-agent's own shop inventory
-- This separates sub-agent shop packages from parent's catalog offerings
CREATE TABLE IF NOT EXISTS sub_agent_shop_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  parent_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  sub_agent_profit_margin NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shop_id, package_id)
);

-- Add indexes for common queries
CREATE INDEX idx_sub_agent_shop_packages_shop_id ON sub_agent_shop_packages(shop_id);
CREATE INDEX idx_sub_agent_shop_packages_package_id ON sub_agent_shop_packages(package_id);
CREATE INDEX idx_sub_agent_shop_packages_active ON sub_agent_shop_packages(is_active);

-- Add comments
COMMENT ON TABLE sub_agent_shop_packages IS 'Sub-agent shop inventory: packages a sub-agent is selling to customers';
COMMENT ON COLUMN sub_agent_shop_packages.parent_price IS 'The parent selling price (parent cost to this sub-agent)';
COMMENT ON COLUMN sub_agent_shop_packages.sub_agent_profit_margin IS 'Sub-agent profit margin: their selling_price - parent_price';

-- Enable RLS
ALTER TABLE sub_agent_shop_packages ENABLE ROW LEVEL SECURITY;

-- Allow service role to bypass RLS (for API routes using service key)
CREATE POLICY "Service role bypass" ON sub_agent_shop_packages
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
