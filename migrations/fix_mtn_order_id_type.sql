-- Migration: Fix MTN order ID type to support string transaction IDs
-- Purpose: DataKazina returns string transaction IDs (e.g., 'dk_...'), while Sykes returns integers.
-- Changing mtn_order_id from INTEGER to TEXT ensures compatibility with both providers.

-- First, drop the unique constraint to allow type conversion
ALTER TABLE public.mtn_fulfillment_tracking DROP CONSTRAINT IF EXISTS mtn_fulfillment_tracking_mtn_order_id_key;

-- Change the column type from INTEGER to TEXT
ALTER TABLE public.mtn_fulfillment_tracking 
ALTER COLUMN mtn_order_id TYPE TEXT USING mtn_order_id::TEXT;

-- Add the unique constraint back
ALTER TABLE public.mtn_fulfillment_tracking ADD CONSTRAINT mtn_fulfillment_tracking_mtn_order_id_key UNIQUE (mtn_order_id);

-- Update idx_mtn_fulfillment_mtn_order_id if it exists (it's already on the column, so it should stay valid)
-- But let's re-create it just in case to ensure optimal performance with TEXT
DROP INDEX IF EXISTS public.idx_mtn_fulfillment_mtn_order_id;
CREATE INDEX idx_mtn_fulfillment_mtn_order_id ON public.mtn_fulfillment_tracking(mtn_order_id);

-- Also update size_gb to NUMERIC if any provider uses decimal GB sizes (like 0.5GB)
-- Sykes rounding to integer already happens in code, but the DB should support it just in case.
ALTER TABLE public.mtn_fulfillment_tracking 
ALTER COLUMN size_gb TYPE NUMERIC USING size_gb::NUMERIC;
