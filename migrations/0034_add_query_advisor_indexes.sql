-- Migration: Add indexes recommended by Supabase query advisor
-- Purpose: Optimize sort and filter performance on frequently used queries
-- Created: 2026-01-05

-- shop_packages: Optimize ORDER BY created_at DESC queries
-- Reduces startup cost from 92.37 to 63.87, total cost from 92.39 to 63.89
CREATE INDEX IF NOT EXISTS idx_shop_packages_created_at ON public.shop_packages(created_at DESC);

-- order_download_batches: Optimize ORDER BY created_at DESC queries
-- Reduces startup cost from 1.31 to 0.45, total cost from 1.33 to 0.47
CREATE INDEX IF NOT EXISTS idx_order_download_batches_created_at ON public.order_download_batches(created_at DESC);

-- shop_profits: Optimize ORDER BY created_at DESC queries
-- Reduces startup cost from 91.08 to 34.36, total cost from 91.1 to 34.38
CREATE INDEX IF NOT EXISTS idx_shop_profits_created_at ON public.shop_profits(created_at DESC);
