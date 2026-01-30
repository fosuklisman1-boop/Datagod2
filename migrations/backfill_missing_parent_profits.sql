-- Backfill missing parent shop profit records
-- This finds all sub-agent orders that have parent_profit_amount > 0
-- but no corresponding profit record for the parent shop
-- Run this in Supabase SQL Editor AFTER running fix_shop_profits_unique_constraint.sql

-- Step 1: Preview - Find orders with missing parent profits
-- Run this first to see what will be backfilled
SELECT 
  so.id as order_id,
  so.reference_code,
  so.shop_id as subagent_shop_id,
  so.parent_shop_id,
  so.parent_profit_amount,
  so.total_price,
  so.payment_status,
  so.order_status,
  so.created_at,
  sp_subagent.id as subagent_profit_id,
  sp_parent.id as parent_profit_id
FROM shop_orders so
LEFT JOIN shop_profits sp_subagent 
  ON sp_subagent.shop_order_id = so.id 
  AND sp_subagent.shop_id = so.shop_id
LEFT JOIN shop_profits sp_parent 
  ON sp_parent.shop_order_id = so.id 
  AND sp_parent.shop_id = so.parent_shop_id
WHERE 
  so.parent_shop_id IS NOT NULL
  AND so.parent_profit_amount > 0
  AND so.payment_status = 'completed'
  AND sp_parent.id IS NULL  -- Parent profit record is missing
ORDER BY so.created_at DESC;

-- Step 2: Count how many orders are affected
SELECT COUNT(*) as missing_parent_profit_count
FROM shop_orders so
LEFT JOIN shop_profits sp_parent 
  ON sp_parent.shop_order_id = so.id 
  AND sp_parent.shop_id = so.parent_shop_id
WHERE 
  so.parent_shop_id IS NOT NULL
  AND so.parent_profit_amount > 0
  AND so.payment_status = 'completed'
  AND sp_parent.id IS NULL;

-- Step 3: INSERT missing parent profit records
-- IMPORTANT: Review the preview above before running this!
INSERT INTO shop_profits (
  shop_id,
  shop_order_id,
  profit_amount,
  profit_balance_before,
  profit_balance_after,
  status,
  created_at
)
SELECT 
  so.parent_shop_id as shop_id,
  so.id as shop_order_id,
  so.parent_profit_amount as profit_amount,
  -- Calculate balance before (sum of existing credited profits for parent)
  COALESCE((
    SELECT SUM(sp2.profit_amount) 
    FROM shop_profits sp2 
    WHERE sp2.shop_id = so.parent_shop_id 
    AND sp2.status IN ('pending', 'credited')
    AND sp2.created_at < so.created_at
  ), 0) as profit_balance_before,
  -- Calculate balance after
  COALESCE((
    SELECT SUM(sp2.profit_amount) 
    FROM shop_profits sp2 
    WHERE sp2.shop_id = so.parent_shop_id 
    AND sp2.status IN ('pending', 'credited')
    AND sp2.created_at < so.created_at
  ), 0) + so.parent_profit_amount as profit_balance_after,
  'credited' as status,
  so.created_at as created_at
FROM shop_orders so
LEFT JOIN shop_profits sp_parent 
  ON sp_parent.shop_order_id = so.id 
  AND sp_parent.shop_id = so.parent_shop_id
WHERE 
  so.parent_shop_id IS NOT NULL
  AND so.parent_profit_amount > 0
  AND so.payment_status = 'completed'
  AND sp_parent.id IS NULL;

-- Step 4: Update shop_available_balance for affected parent shops
-- First delete existing records for parent shops, then insert fresh ones

-- Delete existing balance records for parent shops
DELETE FROM shop_available_balance
WHERE shop_id IN (
  SELECT DISTINCT parent_shop_id 
  FROM shop_orders 
  WHERE parent_shop_id IS NOT NULL
);

-- Insert fresh balance records
WITH parent_balances AS (
  SELECT 
    sp.shop_id,
    SUM(CASE WHEN sp.status = 'credited' THEN sp.profit_amount ELSE 0 END) as credited_profit,
    SUM(sp.profit_amount) as total_profit
  FROM shop_profits sp
  WHERE sp.shop_id IN (
    SELECT DISTINCT parent_shop_id 
    FROM shop_orders 
    WHERE parent_shop_id IS NOT NULL
  )
  GROUP BY sp.shop_id
),
withdrawal_totals AS (
  SELECT 
    shop_id,
    SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) as total_withdrawn
  FROM withdrawal_requests
  WHERE shop_id IN (SELECT shop_id FROM parent_balances)
  GROUP BY shop_id
)
INSERT INTO shop_available_balance (
  shop_id,
  available_balance,
  total_profit,
  credited_profit,
  withdrawn_amount,
  withdrawn_profit,
  created_at,
  updated_at
)
SELECT 
  pb.shop_id,
  GREATEST(0, pb.credited_profit - COALESCE(wt.total_withdrawn, 0)) as available_balance,
  pb.total_profit,
  pb.credited_profit,
  COALESCE(wt.total_withdrawn, 0) as withdrawn_amount,
  COALESCE(wt.total_withdrawn, 0) as withdrawn_profit,
  NOW() as created_at,
  NOW() as updated_at
FROM parent_balances pb
LEFT JOIN withdrawal_totals wt ON wt.shop_id = pb.shop_id;


-- Step 5: Verify - Show parent shops with their updated balances
SELECT 
  us.id as shop_id,
  us.shop_name,
  us.shop_slug,
  sab.available_balance,
  sab.total_profit,
  sab.credited_profit,
  sab.withdrawn_amount,
  (SELECT COUNT(*) FROM shop_profits WHERE shop_id = us.id) as profit_record_count,
  (SELECT COUNT(*) FROM shop_orders WHERE parent_shop_id = us.id AND payment_status = 'completed') as subagent_orders_count
FROM user_shops us
JOIN shop_available_balance sab ON sab.shop_id = us.id
WHERE us.id IN (
  SELECT DISTINCT parent_shop_id FROM user_shops WHERE parent_shop_id IS NOT NULL
)
ORDER BY sab.available_balance DESC;

