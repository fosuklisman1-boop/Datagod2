-- Add temporary block support to user_shops
-- Run this in Supabase SQL editor

ALTER TABLE user_shops
  ADD COLUMN IF NOT EXISTS is_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS block_reason text,
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz;

-- Index for efficient filtering of non-blocked active shops
CREATE INDEX IF NOT EXISTS idx_user_shops_active_not_blocked
  ON user_shops (shop_slug)
  WHERE is_active = true AND is_blocked = false;
