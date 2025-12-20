-- Fix fulfillment_logs foreign key constraint to support both orders and shop_orders
-- This migration removes the FK constraint to allow logging for both order types

-- Step 1: Drop the existing foreign key constraint
ALTER TABLE fulfillment_logs DROP CONSTRAINT IF EXISTS fulfillment_logs_order_id_fkey;

-- Step 2: Drop the unique constraint on order_id (if exists)
ALTER TABLE fulfillment_logs DROP CONSTRAINT IF EXISTS fulfillment_logs_order_id_key;

-- Step 3: Add order_type column to distinguish between order sources
ALTER TABLE fulfillment_logs ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) DEFAULT 'wallet';
-- wallet = orders table
-- shop = shop_orders table

-- Step 4: Create index on order_type for faster queries
CREATE INDEX IF NOT EXISTS idx_fulfillment_logs_order_type ON fulfillment_logs(order_type);

-- Step 5: Update RLS policies for the new structure
DROP POLICY IF EXISTS "Service role can insert fulfillment logs" ON fulfillment_logs;
DROP POLICY IF EXISTS "Service role can select fulfillment logs" ON fulfillment_logs;
DROP POLICY IF EXISTS "Service role can update fulfillment logs" ON fulfillment_logs;
DROP POLICY IF EXISTS "Service role can delete fulfillment logs" ON fulfillment_logs;

-- Create permissive policies for system operations
CREATE POLICY "Allow all fulfillment log operations"
ON fulfillment_logs
FOR ALL
USING (true)
WITH CHECK (true);

-- Add comment explaining the change
COMMENT ON TABLE fulfillment_logs IS 'Tracks fulfillment attempts for both wallet orders (orders table) and shop orders (shop_orders table). order_type distinguishes the source.';
COMMENT ON COLUMN fulfillment_logs.order_id IS 'UUID of the order - can be from orders table OR shop_orders table depending on order_type';
COMMENT ON COLUMN fulfillment_logs.order_type IS 'wallet = orders table, shop = shop_orders table';
