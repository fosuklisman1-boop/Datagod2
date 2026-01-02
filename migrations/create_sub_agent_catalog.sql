-- Migration: Create Sub-Agent Catalog Table
-- This table stores packages that shop owners make available to their sub-agents

-- Create sub_agent_catalog table
CREATE TABLE IF NOT EXISTS sub_agent_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  wholesale_margin DECIMAL(10, 2) NOT NULL DEFAULT 0, -- Shop owner's margin (added to admin price)
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Ensure unique package per shop
  UNIQUE(shop_id, package_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sub_agent_catalog_shop ON sub_agent_catalog(shop_id);
CREATE INDEX IF NOT EXISTS idx_sub_agent_catalog_package ON sub_agent_catalog(package_id);
CREATE INDEX IF NOT EXISTS idx_sub_agent_catalog_active ON sub_agent_catalog(is_active);

-- Enable RLS
ALTER TABLE sub_agent_catalog ENABLE ROW LEVEL SECURITY;

-- Policy: Shop owners can manage their own catalog
CREATE POLICY "Shop owners can manage their catalog"
ON sub_agent_catalog
FOR ALL
USING (
  shop_id IN (
    SELECT id FROM user_shops WHERE user_id = auth.uid()
  )
);

-- Policy: Sub-agents can read their parent's catalog
CREATE POLICY "Sub-agents can read parent catalog"
ON sub_agent_catalog
FOR SELECT
USING (
  shop_id IN (
    SELECT parent_shop_id FROM user_shops WHERE user_id = auth.uid() AND parent_shop_id IS NOT NULL
  )
);

-- Comment explaining the table
COMMENT ON TABLE sub_agent_catalog IS 'Packages that shop owners make available to their sub-agents. Wholesale price = admin package price + wholesale_margin';
