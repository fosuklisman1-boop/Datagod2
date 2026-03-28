-- ============================================================
-- Backfill: Fix airtime orders stuck in payment_status = 'pending'
-- due to the race condition on the confirmation page.
-- 
-- These are orders where:
--   1. wallet_payments.status = 'completed'  (Paystack confirmed)
--   2. airtime_orders.payment_status != 'completed' (DB wasn't updated)
--
-- Safe to run multiple times (idempotent).
-- ============================================================

-- STEP 1: Preview affected orders before applying (run SELECT first)
/*
SELECT
  ao.id AS airtime_order_id,
  ao.payment_status AS current_payment_status,
  ao.status AS current_status,
  ao.beneficiary_phone,
  ao.airtime_amount,
  ao.network,
  ao.created_at,
  wp.reference,
  wp.status AS wallet_payment_status
FROM public.airtime_orders ao
INNER JOIN public.wallet_payments wp
  ON wp.order_id = ao.id
  AND wp.order_type = 'airtime'
WHERE wp.status = 'completed'
  AND (ao.payment_status IS NULL OR ao.payment_status = 'pending')
  AND ao.status NOT IN ('failed', 'flagged')
ORDER BY ao.created_at DESC;
*/

-- STEP 2: Update affected airtime orders to payment_status = 'completed'
-- and set status = 'pending' (awaiting airtime delivery) if still unset
UPDATE public.airtime_orders ao
SET
  payment_status = 'completed',
  status = CASE
    WHEN ao.status IN ('pending_payment', 'pending') THEN 'pending'
    ELSE ao.status  -- don't override completed/failed/flagged
  END,
  updated_at = NOW()
FROM public.wallet_payments wp
WHERE wp.order_id = ao.id
  AND wp.order_type = 'airtime'
  AND wp.status = 'completed'
  AND (ao.payment_status IS NULL OR ao.payment_status NOT IN ('completed', 'failed'));


-- STEP 3: Also backfill shop_profits for any of those airtime orders
-- that had a merchant commission but the profit record was never created.
INSERT INTO public.shop_profits (
  shop_id,
  airtime_order_id,
  profit_amount,
  status,
  created_at,
  updated_at
)
SELECT
  ao.shop_id,
  ao.id,
  ao.merchant_commission,
  'credited',
  NOW(),
  NOW()
FROM public.airtime_orders ao
INNER JOIN public.wallet_payments wp
  ON wp.order_id = ao.id
  AND wp.order_type = 'airtime'
WHERE wp.status = 'completed'
  AND ao.merchant_commission > 0
  AND ao.shop_id IS NOT NULL
  -- Only insert if no profit record already exists for this airtime order
  AND NOT EXISTS (
    SELECT 1 FROM public.shop_profits sp
    WHERE sp.airtime_order_id = ao.id
  );


-- STEP 4: Verification — check how many were fixed
SELECT
  COUNT(*) AS total_fixed,
  SUM(ao.airtime_amount) AS total_airtime_ghs
FROM public.airtime_orders ao
INNER JOIN public.wallet_payments wp
  ON wp.order_id = ao.id
  AND wp.order_type = 'airtime'
WHERE wp.status = 'completed'
  AND ao.payment_status = 'completed';
