-- Migration: Allow shop_profits to track airtime orders and disburse immediately
-- This migration makes shop_order_id nullable and adds airtime_order_id

DO $$ 
BEGIN 
    -- 1. shop_id remains NOT NULL (It is already NOT NULL in the original schema)
    -- We only make shop_order_id nullable because a profit can now come from 
    -- EITHER a Data Order (shop_orders) OR an Airtime Order (airtime_orders).
    ALTER TABLE shop_profits ALTER COLUMN shop_order_id DROP NOT NULL;

    -- 2. Add airtime_order_id column
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'shop_profits' AND COLUMN_NAME = 'airtime_order_id') THEN
        ALTER TABLE shop_profits ADD COLUMN airtime_order_id UUID REFERENCES airtime_orders(id) ON DELETE SET NULL;
    END IF;

    -- 3. Add index for performance
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'shop_profits' AND indexname = 'idx_shop_profits_airtime_order_id') THEN
        CREATE INDEX idx_shop_profits_airtime_order_id ON shop_profits(airtime_order_id);
    END IF;

    -- 4. Update status check to include 'failed' or 'reversed' if needed
    -- (Assuming status is already VARCHAR and has a check constraint or just loose values)
END $$;
