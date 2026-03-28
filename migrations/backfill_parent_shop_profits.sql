-- Backfill: Create missing parent shop profit records for sub-agent card payments
-- These were missed because the webhook/verify routes only created sub-agent profits.
-- The DB trigger (from shop_balance_sync_trigger_v1.sql) will automatically
-- update shop_available_balance for every parent shop after each insert.

DO $$
DECLARE
  v_count INTEGER := 0;
  r RECORD;
BEGIN
  -- Find all completed sub-agent orders that are missing a parent profit record
  FOR r IN
    SELECT
      so.id            AS order_id,
      so.parent_shop_id,
      so.parent_profit_amount,
      so.created_at
    FROM shop_orders so
    WHERE so.parent_shop_id IS NOT NULL
      AND so.parent_profit_amount > 0
      AND so.payment_status = 'completed'
      -- No parent profit record exists yet
      AND NOT EXISTS (
        SELECT 1
        FROM shop_profits sp
        WHERE sp.shop_order_id = so.id
          AND sp.shop_id = so.parent_shop_id
      )
    ORDER BY so.created_at ASC
  LOOP
    INSERT INTO shop_profits (
      shop_id,
      shop_order_id,
      profit_amount,
      status,
      created_at
    )
    VALUES (
      r.parent_shop_id,
      r.order_id,
      r.parent_profit_amount,
      'credited',
      r.created_at  -- Use original order date to preserve history
    );

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'Backfill complete: % missing parent profit records inserted.', v_count;
END $$;

-- Verify: show how many parent shop profits now exist vs sub-agent profits on the same orders
SELECT
  COUNT(*) FILTER (WHERE sp.shop_id = so.shop_id)        AS sub_agent_profits,
  COUNT(*) FILTER (WHERE sp.shop_id = so.parent_shop_id) AS parent_profits
FROM shop_profits sp
JOIN shop_orders so ON sp.shop_order_id = so.id
WHERE so.parent_shop_id IS NOT NULL;
