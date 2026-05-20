-- Migration: Allow shop_available_balance to go negative
-- This updates the sync_shop_balance function to remove the GREATEST(0, ...) check.
-- This allows admins to "negavate" an account (create a negative balance/debt).

CREATE OR REPLACE FUNCTION sync_shop_balance(p_shop_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_profit         NUMERIC := 0;
  v_credited_profit      NUMERIC := 0;
  v_withdrawn_profit     NUMERIC := 0;
  v_total_withdrawals    NUMERIC := 0;
  v_available_balance    NUMERIC := 0;
BEGIN
  -- Sum profits by status
  SELECT
    COALESCE(SUM(profit_amount), 0),
    COALESCE(SUM(CASE WHEN status = 'credited'  THEN profit_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status = 'withdrawn' THEN profit_amount ELSE 0 END), 0)
  INTO v_total_profit, v_credited_profit, v_withdrawn_profit
  FROM shop_profits
  WHERE shop_id = p_shop_id;

  -- Sum approved withdrawals
  SELECT COALESCE(SUM(amount), 0)
  INTO v_total_withdrawals
  FROM withdrawal_requests
  WHERE shop_id = p_shop_id
    AND status IN ('approved', 'completed');

  -- ALLOW NEGATIVE BALANCE
  -- Previous version used: v_available_balance := GREATEST(0, v_credited_profit - v_total_withdrawals);
  v_available_balance := v_credited_profit - v_total_withdrawals;

  -- Upsert balance record
  INSERT INTO shop_available_balance (
    shop_id,
    available_balance,
    total_profit,
    credited_profit,
    withdrawn_profit,
    withdrawn_amount,
    created_at,
    updated_at
  )
  VALUES (
    p_shop_id,
    v_available_balance,
    v_total_profit,
    v_credited_profit,
    v_withdrawn_profit,
    v_total_withdrawals,
    NOW(),
    NOW()
  )
  ON CONFLICT (shop_id)
  DO UPDATE SET
    available_balance = EXCLUDED.available_balance,
    total_profit      = EXCLUDED.total_profit,
    credited_profit   = EXCLUDED.credited_profit,
    withdrawn_profit  = EXCLUDED.withdrawn_profit,
    withdrawn_amount  = EXCLUDED.withdrawn_amount,
    updated_at        = NOW();
END;
$$;

-- Run a backfill to update all existing balances immediately
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM user_shops LOOP
    PERFORM sync_shop_balance(r.id);
  END LOOP;
END $$;
