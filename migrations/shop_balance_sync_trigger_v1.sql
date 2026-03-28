-- Migration: Auto-sync shop_available_balance via DB trigger
-- Replaces application-level syncShopBalance() calls.
-- Fires any time shop_profits or withdrawal_requests change.

-- ─── 1. Core sync function ────────────────────────────────────────────────────
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
    AND status = 'approved';

  v_available_balance := GREATEST(0, v_credited_profit - v_total_withdrawals);

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
    v_withdrawn_profit,
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

-- ─── 2. Trigger function (called by both triggers below) ──────────────────────
CREATE OR REPLACE FUNCTION trg_sync_shop_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_shop_id UUID;
BEGIN
  -- Determine which shop to sync
  v_shop_id := COALESCE(NEW.shop_id, OLD.shop_id);
  IF v_shop_id IS NOT NULL THEN
    PERFORM sync_shop_balance(v_shop_id);
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 3. Trigger on shop_profits ───────────────────────────────────────────────
DROP TRIGGER IF EXISTS after_shop_profits_change ON shop_profits;
CREATE TRIGGER after_shop_profits_change
  AFTER INSERT OR UPDATE OF profit_amount, status
  ON shop_profits
  FOR EACH ROW
  EXECUTE FUNCTION trg_sync_shop_balance();

-- ─── 4. Trigger on withdrawal_requests ───────────────────────────────────────
DROP TRIGGER IF EXISTS after_withdrawal_requests_change ON withdrawal_requests;
CREATE TRIGGER after_withdrawal_requests_change
  AFTER INSERT OR UPDATE OF amount, status
  ON withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION trg_sync_shop_balance();

-- ─── 5. Deduplicate + add unique constraint on shop_available_balance ──────────
-- Required for the ON CONFLICT (shop_id) upsert above.
-- Step 5a: Remove duplicate rows, keeping only the most recently updated per shop.
DELETE FROM shop_available_balance
WHERE id NOT IN (
  SELECT DISTINCT ON (shop_id) id
  FROM shop_available_balance
  ORDER BY shop_id, updated_at DESC NULLS LAST
);

-- Step 5b: Now safely add the unique constraint (if not already present).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'shop_available_balance'::regclass
      AND contype = 'u'
      AND conname = 'unique_shop_available_balance_shop_id'
  ) THEN
    ALTER TABLE shop_available_balance
      ADD CONSTRAINT unique_shop_available_balance_shop_id UNIQUE (shop_id);
  END IF;
END $$;

-- ─── 6. Backfill: sync every existing shop now ────────────────────────────────
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT shop_id FROM shop_profits WHERE shop_id IS NOT NULL LOOP
    PERFORM sync_shop_balance(r.shop_id);
  END LOOP;
END $$;
