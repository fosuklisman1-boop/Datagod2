-- ============================================================
-- Backfill: Fix airtime orders stuck in payment_status = 'pending_payment'
-- due to the race condition on the confirmation page.
--
-- These are orders where:
--   1. wallet_payments.status = 'completed'  (Paystack confirmed)
--   2. airtime_orders.payment_status = 'pending_payment' (DB was never updated)
--
-- HOW TO USE:
--   Run STEP 1 first (SELECT only) to preview affected orders.
--   Then run STEP 2 + STEP 3 together to apply the fix.
--   Run STEP 4 to verify results.
-- ============================================================


-- STEP 1 (PREVIEW ONLY — run this first, do not run STEP 2 until you verify):
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
  AND (ao.payment_status IS NULL OR ao.payment_status = 'pending_payment')
  AND ao.status NOT IN ('failed', 'flagged')
ORDER BY ao.created_at DESC;


-- ============================================================
-- STEP 2: Fix payment_status and status on affected airtime orders.
-- ============================================================
UPDATE public.airtime_orders
SET
  payment_status = 'completed',
  status = CASE
    WHEN status = 'pending_payment' THEN 'pending'
    ELSE status
  END,
  updated_at = NOW()
WHERE id IN (
  SELECT ao.id
  FROM public.airtime_orders ao
  INNER JOIN public.wallet_payments wp
    ON wp.order_id = ao.id
    AND wp.order_type = 'airtime'
  WHERE wp.status = 'completed'
    AND (ao.payment_status IS NULL OR ao.payment_status = 'pending_payment')
);


-- ============================================================
-- STEP 3: Create missing shop_profits records for merchant commissions.
-- ============================================================
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
  AND NOT EXISTS (
    SELECT 1 FROM public.shop_profits sp
    WHERE sp.airtime_order_id = ao.id
  );


-- ============================================================
-- STEP 4 (VERIFY): Check how many orders were fixed.
-- ============================================================
SELECT
  COUNT(*) AS total_fixed,
  SUM(ao.airtime_amount) AS total_airtime_ghs
FROM public.airtime_orders ao
INNER JOIN public.wallet_payments wp
  ON wp.order_id = ao.id
  AND wp.order_type = 'airtime'
WHERE wp.status = 'completed'
  AND ao.payment_status = 'completed';
