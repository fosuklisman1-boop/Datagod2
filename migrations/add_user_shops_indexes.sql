-- Add indexes to user_shops table for better performance on pending shops queries
-- These indexes will speed up filtering by is_active and sorting by created_at

-- Index on is_active for faster filtering of pending shops
CREATE INDEX IF NOT EXISTS idx_user_shops_is_active ON user_shops(is_active);

-- Index on created_at for faster ordering
CREATE INDEX IF NOT EXISTS idx_user_shops_created_at ON user_shops(created_at DESC);

-- Composite index for common query pattern: filter by is_active and sort by created_at
CREATE INDEX IF NOT EXISTS idx_user_shops_is_active_created_at ON user_shops(is_active, created_at DESC);
