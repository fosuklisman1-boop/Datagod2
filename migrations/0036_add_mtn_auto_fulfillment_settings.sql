-- Migration: Add MTN auto-fulfillment settings
-- Purpose: Control whether MTN orders are auto-fulfilled or require manual download
-- Created: 2026-01-05

-- Add column to shop_orders if it doesn't exist
ALTER TABLE public.shop_orders
ADD COLUMN IF NOT EXISTS fulfillment_method VARCHAR(50) DEFAULT 'manual',
ADD COLUMN IF NOT EXISTS external_order_id INTEGER;

-- Create index for external_order_id
CREATE INDEX IF NOT EXISTS idx_shop_orders_external_order_id ON public.shop_orders(external_order_id);
CREATE INDEX IF NOT EXISTS idx_shop_orders_fulfillment_method ON public.shop_orders(fulfillment_method);

-- Insert app_settings for MTN auto-fulfillment if not exists
INSERT INTO public.app_settings (key, value, description, updated_at)
VALUES (
  'mtn_auto_fulfillment_enabled',
  'false',
  'Enable/disable automatic fulfillment of MTN orders via MTN API. When disabled, orders appear in admin download queue.',
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Insert minimum balance alert threshold if not exists
INSERT INTO public.app_settings (key, value, description, updated_at)
VALUES (
  'mtn_balance_alert_threshold',
  '500',
  'Alert admin when MTN wallet balance drops below this amount (GHS)',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
