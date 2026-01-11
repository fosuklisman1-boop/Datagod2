-- Backfill profit_balance_before and profit_balance_after for existing shop_profits records
-- This calculates the running AVAILABLE balance (pending + credited only, excluding withdrawn)

-- Use a CTE with window functions to calculate running totals per shop
-- Only count profits that are still available (pending or credited)
WITH available_profits AS (
  SELECT 
    id,
    shop_id,
    profit_amount,
    status,
    created_at,
    -- Only count this profit's amount if it's still available (not withdrawn)
    CASE WHEN status IN ('pending', 'credited') THEN profit_amount ELSE 0 END AS available_amount
  FROM shop_profits
),
profit_running_totals AS (
  SELECT 
    id,
    shop_id,
    available_amount,
    status,
    created_at,
    -- Calculate available balance before this record (sum of previous available profits)
    COALESCE(
      SUM(available_amount) OVER (
        PARTITION BY shop_id 
        ORDER BY created_at, id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) AS calculated_balance_before,
    -- Calculate available balance after this record
    SUM(available_amount) OVER (
      PARTITION BY shop_id 
      ORDER BY created_at, id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS calculated_balance_after
  FROM available_profits
)
UPDATE shop_profits sp
SET 
  profit_balance_before = prt.calculated_balance_before,
  profit_balance_after = prt.calculated_balance_after
FROM profit_running_totals prt
WHERE sp.id = prt.id
  AND (sp.profit_balance_before IS NULL OR sp.profit_balance_after IS NULL);

-- Verify the update
SELECT 
  COUNT(*) as total_records,
  COUNT(profit_balance_before) as records_with_balance_before,
  COUNT(profit_balance_after) as records_with_balance_after
FROM shop_profits;
