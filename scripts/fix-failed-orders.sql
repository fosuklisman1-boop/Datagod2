-- =====================================================
-- SCRIPT: Fix Incorrectly Failed Shop Orders
-- =====================================================
-- Run this in your Supabase SQL Editor
-- This identifies and fixes shop orders that were incorrectly marked as failed
-- due to the payment verification bug (now fixed)
-- =====================================================

-- STEP 1: IDENTIFY affected orders
-- These are shop orders where:
--   - order_status = 'failed' 
--   - payment_status = 'completed' OR wallet_payments.status = 'completed'
--   - The failure was due to amount mismatch (not a real payment failure)

-- First, let's see how many orders are affected (READ ONLY - no changes)
SELECT 
    so.id as order_id,
    so.reference_code,
    so.customer_phone,
    so.network,
    so.volume_gb,
    so.total_price,
    so.order_status,
    so.payment_status,
    so.created_at,
    wp.status as wallet_payment_status,
    wp.failure_reason
FROM shop_orders so
LEFT JOIN wallet_payments wp ON wp.order_id = so.id
WHERE so.order_status = 'failed'
  AND (
    so.payment_status = 'completed' 
    OR wp.status = 'completed'
    OR wp.failure_reason LIKE '%mismatch%'
  )
ORDER BY so.created_at DESC
LIMIT 100;

-- =====================================================
-- STEP 2: FIX the orders (UNCOMMENT TO RUN)
-- This will update the order_status from 'failed' to 'pending'
-- so they can be fulfilled again
-- =====================================================

/*
-- Update shop_orders to pending (so admin can fulfill them)
UPDATE shop_orders
SET 
    order_status = 'pending',
    updated_at = NOW()
WHERE order_status = 'failed'
  AND id IN (
    SELECT so.id 
    FROM shop_orders so
    LEFT JOIN wallet_payments wp ON wp.order_id = so.id
    WHERE so.order_status = 'failed'
      AND (
        so.payment_status = 'completed' 
        OR wp.status = 'completed'
        OR wp.failure_reason LIKE '%mismatch%'
      )
  );
*/

-- =====================================================
-- STEP 3: Also fix the wallet_payments if needed
-- =====================================================

/*
-- Update wallet_payments status if it was incorrectly marked as failed
UPDATE wallet_payments
SET 
    status = 'completed',
    failure_reason = NULL,
    updated_at = NOW()
WHERE status = 'failed'
  AND failure_reason LIKE '%mismatch%'
  AND order_id IN (
    SELECT id FROM shop_orders WHERE payment_status = 'completed'
  );
*/

-- =====================================================
-- STEP 4: Verify the fix
-- =====================================================

-- After running the UPDATE, check the results:
/*
SELECT 
    so.id,
    so.reference_code,
    so.order_status,
    so.payment_status,
    so.customer_phone,
    so.network,
    so.volume_gb
FROM shop_orders so
WHERE so.order_status = 'pending'
  AND so.payment_status = 'completed'
  AND so.updated_at > NOW() - INTERVAL '1 hour'
ORDER BY so.updated_at DESC;
*/
