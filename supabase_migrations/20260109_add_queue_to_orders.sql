-- Migration: Add queue column to orders table (wallet orders)
-- Purpose: Track order status queue (default, blacklisted, etc.) for fulfillment control
-- Date: 2026-01-09

-- Add queue column to orders (wallet orders table)
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS queue VARCHAR(50) DEFAULT 'default';

-- Create index on queue for efficient filtering
CREATE INDEX IF NOT EXISTS idx_orders_queue ON orders(queue);

-- Add comment to document the column purpose
COMMENT ON COLUMN orders.queue IS 'Order queue status: default (normal), blacklisted (phone number blacklisted), pending_download (awaiting credit to account), etc.';
