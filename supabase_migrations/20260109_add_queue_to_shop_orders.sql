-- Migration: Add queue column to shop_orders table
-- Purpose: Track order status queue (default, blacklisted, etc.) for fulfillment control
-- Date: 2026-01-09

-- Add queue column to shop_orders
ALTER TABLE shop_orders
ADD COLUMN IF NOT EXISTS queue VARCHAR(50) DEFAULT 'default';

-- Create index on queue for efficient filtering
CREATE INDEX IF NOT EXISTS idx_shop_orders_queue ON shop_orders(queue);

-- Add comment to document the column purpose
COMMENT ON COLUMN shop_orders.queue IS 'Order queue status: default (normal), blacklisted (phone number blacklisted), pending_download (awaiting credit to account), etc.';
