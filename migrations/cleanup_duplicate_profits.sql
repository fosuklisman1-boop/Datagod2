-- Clean up duplicate profit records and add unique constraint
-- Run this in Supabase SQL Editor

-- Step 1: Find and delete duplicate profit records (keeping only the first one per shop_order_id)
WITH duplicates AS (
  SELECT id, shop_order_id,
    ROW_NUMBER() OVER (PARTITION BY shop_order_id ORDER BY created_at ASC) as rn
  FROM shop_profits
  WHERE shop_order_id IS NOT NULL
)
DELETE FROM shop_profits
WHERE id IN (
  SELECT id FROM duplicates WHERE rn > 1
);

-- Step 2: Add unique constraint to prevent future duplicates
ALTER TABLE shop_profits
ADD CONSTRAINT unique_shop_order_profit UNIQUE (shop_order_id);

-- Step 3: Verify - should show no duplicates
SELECT shop_order_id, COUNT(*) as count
FROM shop_profits
WHERE shop_order_id IS NOT NULL
GROUP BY shop_order_id
HAVING COUNT(*) > 1;
