-- Add indexes to user_shops table for better performance on pending shops queries
-- These indexes will speed up filtering by is_active and sorting by created_at

-- Index on is_active for faster filtering of pending shops
CREATE INDEX IF NOT EXISTS idx_user_shops_is_active ON user_shops(is_active);

-- Index on created_at for faster ordering
CREATE INDEX IF NOT EXISTS idx_user_shops_created_at ON user_shops(created_at DESC);

-- Composite index for common query pattern: filter by is_active and sort by created_at
CREATE INDEX IF NOT EXISTS idx_user_shops_is_active_created_at ON user_shops(is_active, created_at DESC);

-- Additional indexes for other frequently queried tables
-- Shop orders indexes (shop_orders has shop_id, NOT user_id)
CREATE INDEX IF NOT EXISTS idx_shop_orders_shop_id ON shop_orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_orders_order_status ON shop_orders(order_status);
CREATE INDEX IF NOT EXISTS idx_shop_orders_shop_id_status ON shop_orders(shop_id, order_status);
CREATE INDEX IF NOT EXISTS idx_shop_orders_payment_status ON shop_orders(payment_status);

-- Shop profits indexes
CREATE INDEX IF NOT EXISTS idx_shop_profits_shop_id ON shop_profits(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_profits_shop_order_id ON shop_profits(shop_order_id);
CREATE INDEX IF NOT EXISTS idx_shop_profits_status ON shop_profits(status);
CREATE INDEX IF NOT EXISTS idx_shop_profits_shop_id_status ON shop_profits(shop_id, status);

-- Withdrawal requests indexes
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_shop_id ON withdrawal_requests(shop_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_shop_id_status ON withdrawal_requests(shop_id, status);
