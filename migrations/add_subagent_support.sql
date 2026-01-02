-- Migration: Add Sub-Agent Support
-- This migration adds support for multi-tier shop reseller system

-- 1. Add parent relationship and tier level to user_shops
ALTER TABLE user_shops ADD COLUMN IF NOT EXISTS parent_shop_id UUID REFERENCES user_shops(id);
ALTER TABLE user_shops ADD COLUMN IF NOT EXISTS tier_level INTEGER DEFAULT 1;

-- Index for fast parent lookups
CREATE INDEX IF NOT EXISTS idx_user_shops_parent ON user_shops(parent_shop_id);

-- 2. Create shop_invites table for tracking invite links
CREATE TABLE IF NOT EXISTS shop_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  invite_code VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(255),
  status VARCHAR(20) DEFAULT 'pending',  -- pending, accepted, expired
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '7 days',
  accepted_by_user_id UUID REFERENCES auth.users(id),
  accepted_at TIMESTAMP
);

-- Indexes for shop_invites
CREATE INDEX IF NOT EXISTS idx_shop_invites_code ON shop_invites(invite_code);
CREATE INDEX IF NOT EXISTS idx_shop_invites_inviter ON shop_invites(inviter_shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_invites_status ON shop_invites(status);

-- 3. Add column to shop_orders to track the chain for profit distribution
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS parent_shop_id UUID REFERENCES user_shops(id);
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS parent_profit_amount DECIMAL(10, 2) DEFAULT 0;

-- 4. RLS Policies for shop_invites

-- Enable RLS
ALTER TABLE shop_invites ENABLE ROW LEVEL SECURITY;

-- Policy: Shop owners can view their own invites
CREATE POLICY "Shop owners can view own invites" ON shop_invites
  FOR SELECT
  USING (
    inviter_shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

-- Policy: Shop owners can create invites for their shop
CREATE POLICY "Shop owners can create invites" ON shop_invites
  FOR INSERT
  WITH CHECK (
    inviter_shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

-- Policy: Shop owners can update their own invites
CREATE POLICY "Shop owners can update own invites" ON shop_invites
  FOR UPDATE
  USING (
    inviter_shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

-- Policy: Anyone can read invite by code (for join page)
CREATE POLICY "Anyone can read invite by code" ON shop_invites
  FOR SELECT
  USING (true);

-- Policy: Service role can do anything (for API)
CREATE POLICY "Service role full access" ON shop_invites
  FOR ALL
  USING (auth.role() = 'service_role');

-- 5. Update RLS for user_shops to allow sub-agents
-- (Existing policies should still work, but we need to ensure sub-agents can access their own shop)

-- 6. Comments for documentation
COMMENT ON COLUMN user_shops.parent_shop_id IS 'ID of parent shop for sub-agents. NULL for tier-1 shops.';
COMMENT ON COLUMN user_shops.tier_level IS 'Hierarchy level: 1 = direct under admin, 2 = sub-agent, etc.';
COMMENT ON COLUMN shop_orders.parent_shop_id IS 'Parent shop ID for profit chain distribution.';
COMMENT ON COLUMN shop_orders.parent_profit_amount IS 'Profit amount to credit to parent shop.';
COMMENT ON TABLE shop_invites IS 'Tracks invite links for sub-agent signups.';
