-- ROLLBACK: Undo database changes made on 2026-01-09
-- Run this in Supabase SQL Editor to revert the changes

-- =====================================================
-- ROLLBACK Migration 0042: mtn_fulfillment_tracking schema
-- =====================================================

-- Remove order_type column if it exists
ALTER TABLE public.mtn_fulfillment_tracking 
DROP COLUMN IF EXISTS order_type;

-- Remove order_id column if it exists
ALTER TABLE public.mtn_fulfillment_tracking 
DROP COLUMN IF EXISTS order_id;

-- Drop indexes we added
DROP INDEX IF EXISTS idx_mtn_fulfillment_order_type;
DROP INDEX IF EXISTS idx_mtn_fulfillment_order_id;

-- Restore original status constraint (without 'processing')
ALTER TABLE public.mtn_fulfillment_tracking 
DROP CONSTRAINT IF EXISTS valid_status;

ALTER TABLE public.mtn_fulfillment_tracking 
ADD CONSTRAINT valid_status CHECK (status IN ('pending', 'completed', 'failed', 'error', 'retrying'));

-- Make shop_order_id NOT NULL again (only if there are no null values)
-- First check if there are any null values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.mtn_fulfillment_tracking WHERE shop_order_id IS NULL
  ) THEN
    ALTER TABLE public.mtn_fulfillment_tracking 
    ALTER COLUMN shop_order_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'Cannot set shop_order_id to NOT NULL - there are null values. Skipping.';
  END IF;
END $$;

-- =====================================================
-- Note: Migrations 0043 and 0044 (security/performance)
-- are generally safe to leave in place as they don't 
-- change functionality, only improve security and performance.
-- 
-- If you want to fully revert them, you would need to:
-- 1. Remove search_path settings from functions
-- 2. Revert RLS policy changes
-- 3. Recreate duplicate indexes
-- 
-- This is NOT recommended as those changes were improvements.
-- =====================================================

-- Verify the rollback
SELECT 
  column_name, 
  data_type, 
  is_nullable
FROM information_schema.columns 
WHERE table_name = 'mtn_fulfillment_tracking'
ORDER BY ordinal_position;
