-- Migration: Fix MTN fulfillment tracking foreign key constraint
-- Purpose: Allow tracking for both shop_orders and bulk orders
-- Created: 2026-01-06

-- Drop the existing foreign key constraint
ALTER TABLE public.mtn_fulfillment_tracking
DROP CONSTRAINT IF EXISTS mtn_fulfillment_tracking_shop_order_id_fkey;

-- Make shop_order_id nullable (for when tracking bulk orders)
ALTER TABLE public.mtn_fulfillment_tracking
ALTER COLUMN shop_order_id DROP NOT NULL;

-- Add order_id column for bulk orders (from orders table)
ALTER TABLE public.mtn_fulfillment_tracking
ADD COLUMN IF NOT EXISTS order_id UUID;

-- Add index on order_id
CREATE INDEX IF NOT EXISTS idx_mtn_fulfillment_order_id ON public.mtn_fulfillment_tracking(order_id);

-- Add order_type column to distinguish between shop and bulk orders
ALTER TABLE public.mtn_fulfillment_tracking
ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) DEFAULT 'shop';

-- Add check constraint for order_type
ALTER TABLE public.mtn_fulfillment_tracking
DROP CONSTRAINT IF EXISTS valid_order_type;

ALTER TABLE public.mtn_fulfillment_tracking
ADD CONSTRAINT valid_order_type CHECK (order_type IN ('shop', 'bulk'));

COMMENT ON COLUMN public.mtn_fulfillment_tracking.shop_order_id IS 'Reference to shop_orders.id for storefront orders';
COMMENT ON COLUMN public.mtn_fulfillment_tracking.order_id IS 'Reference to orders.id for bulk/data package orders';
COMMENT ON COLUMN public.mtn_fulfillment_tracking.order_type IS 'Type of order: shop (storefront) or bulk (data packages)';
