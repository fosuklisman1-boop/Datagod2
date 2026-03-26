-- Backfill payment_status for airtime orders that were paid via wallet but are missing the status
-- These orders are currently hidden from the admin "Pending" tab because it filters for payment_status = 'completed'

UPDATE public.airtime_orders
SET payment_status = 'completed'
WHERE payment_status IS NULL
AND status IN ('pending', 'processing', 'completed');

-- Also ensure any future wallet-based orders that might have missed the status (if any other code path exists) are captured
-- This is a safety measure.
