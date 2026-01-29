-- Add order_id and order_type columns to mtn_fulfillment_tracking table
-- This allows tracking which shop/bulk order triggered the MTN fulfillment

ALTER TABLE mtn_fulfillment_tracking 
ADD COLUMN IF NOT EXISTS order_id VARCHAR(64),
ADD COLUMN IF NOT EXISTS order_type VARCHAR(16);

-- Create index on order_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_mtn_fulfillment_order_id ON mtn_fulfillment_tracking(order_id);
