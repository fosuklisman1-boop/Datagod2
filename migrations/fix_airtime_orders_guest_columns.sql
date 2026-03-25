-- Fix airtime_orders table for guest purchases
-- 1. Make user_id nullable for non-logged in users
ALTER TABLE public.airtime_orders ALTER COLUMN user_id DROP NOT NULL;

-- 2. Add guest info columns
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending';

-- 3. Update status constraint to include pending_payment
ALTER TABLE public.airtime_orders DROP CONSTRAINT IF EXISTS airtime_orders_status_check;
ALTER TABLE public.airtime_orders ADD CONSTRAINT airtime_orders_status_check 
    CHECK (status IN ('pending', 'pending_payment', 'processing', 'completed', 'failed', 'flagged'));
