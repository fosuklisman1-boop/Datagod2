-- Migration: Fix external_order_id types to support string IDs (e.g., DataKazina 'dk_...')
-- Purpose: Convert external_order_id columns from INTEGER/BIGINT to TEXT to support all providers.

-- 1. Fix shop_orders table
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shop_orders' AND column_name = 'external_order_id') THEN
    
    -- Drop index if it exists (will be recreated later)
    DROP INDEX IF EXISTS idx_shop_orders_external_order_id;
    
    -- Change type to TEXT
    ALTER TABLE public.shop_orders 
    ALTER COLUMN external_order_id TYPE TEXT USING external_order_id::TEXT;
    
    -- Recreate index
    CREATE INDEX IF NOT EXISTS idx_shop_orders_external_order_id ON public.shop_orders(external_order_id);
    
    RAISE NOTICE 'Updated shop_orders.external_order_id to TEXT';
  END IF;
END $$;

-- 2. Fix orders table
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'external_order_id') THEN
    
    ALTER TABLE public.orders 
    ALTER COLUMN external_order_id TYPE TEXT USING external_order_id::TEXT;
    
    RAISE NOTICE 'Updated orders.external_order_id to TEXT';
  ELSE
    -- If it doesn't exist, add it as TEXT for future use
    ALTER TABLE public.orders ADD COLUMN external_order_id TEXT;
    RAISE NOTICE 'Added orders.external_order_id as TEXT';
  END IF;
END $$;

-- 3. Fix fulfillment_logs table
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'fulfillment_logs' AND column_name = 'external_order_id') THEN
    
    ALTER TABLE public.fulfillment_logs 
    ALTER COLUMN external_order_id TYPE TEXT USING external_order_id::TEXT;
    
    RAISE NOTICE 'Updated fulfillment_logs.external_order_id to TEXT';
  ELSE
    -- If it doesn't exist, add it
    ALTER TABLE public.fulfillment_logs ADD COLUMN external_order_id TEXT;
    RAISE NOTICE 'Added fulfillment_logs.external_order_id as TEXT';
  END IF;
END $$;
