-- Fix unique constraint on shop_profits to allow parent shop profits
-- The original constraint only allowed one profit per shop_order_id
-- But sub-agent sales need TWO profit records (sub-agent + parent shop)
-- Run this in Supabase SQL Editor

-- Step 1: Drop the problematic constraint
ALTER TABLE shop_profits DROP CONSTRAINT IF EXISTS unique_shop_order_profit;

-- Step 2: Add correct composite constraint
-- This allows one profit record per (shop_order_id, shop_id) combination
-- So both sub-agent AND parent can have a profit record for the same order
ALTER TABLE shop_profits 
ADD CONSTRAINT unique_shop_order_shop_profit UNIQUE (shop_order_id, shop_id);

-- Step 3: Verify the constraint was created
SELECT 
  conname as constraint_name,
  contype as constraint_type
FROM pg_constraint 
WHERE conrelid = 'shop_profits'::regclass
AND conname LIKE '%shop_order%';
