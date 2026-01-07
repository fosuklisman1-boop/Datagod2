-- =============================================
-- AUTO-CREATE MISSING SETTINGS IN BOTH TABLES
-- =============================================
-- This script ensures all required settings exist with proper defaults
-- Run this INSTEAD OF the individual fix_*.sql files for complete setup

-- =============================================
-- PART 1: FIX APP_SETTINGS TABLE RLS POLICIES
-- =============================================

DROP POLICY IF EXISTS "Anyone can read app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Service role can insert app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Service role can update app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Service role can delete app_settings" ON public.app_settings;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read app_settings"
  ON public.app_settings FOR SELECT
  USING (true);

CREATE POLICY "Service role can insert app_settings"
  ON public.app_settings FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role can update app_settings"
  ON public.app_settings FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role can delete app_settings"
  ON public.app_settings FOR DELETE
  USING (true);

-- =============================================
-- PART 2: ENSURE DEFAULT APP_SETTINGS ROW EXISTS
-- =============================================

-- Create default row if none exists
INSERT INTO public.app_settings (
  join_community_link,
  announcement_enabled,
  announcement_title,
  announcement_message,
  christmas_theme_enabled,
  paystack_fee_percentage,
  wallet_topup_fee_percentage,
  withdrawal_fee_percentage,
  price_adjustment_mtn,
  price_adjustment_telecel,
  price_adjustment_at_ishare,
  price_adjustment_at_bigtime,
  created_at,
  updated_at
)
SELECT
  '',
  false,
  '',
  '',
  false,
  3.0,
  0.0,
  0.0,
  0,
  0,
  0,
  0,
  now(),
  now()
WHERE NOT EXISTS (SELECT 1 FROM public.app_settings)
ON CONFLICT DO NOTHING;

-- =============================================
-- PART 3: FIX ADMIN_SETTINGS TABLE RLS POLICIES
-- =============================================

DROP POLICY IF EXISTS "Service role can read admin_settings" ON public.admin_settings;
DROP POLICY IF EXISTS "Service role can insert admin_settings" ON public.admin_settings;
DROP POLICY IF EXISTS "Service role can update admin_settings" ON public.admin_settings;
DROP POLICY IF EXISTS "Service role can delete admin_settings" ON public.admin_settings;
DROP POLICY IF EXISTS "Admins can read settings" ON public.admin_settings;
DROP POLICY IF EXISTS "Admins can update settings" ON public.admin_settings;
DROP POLICY IF EXISTS "Admins can insert settings" ON public.admin_settings;

ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can read admin_settings"
  ON public.admin_settings FOR SELECT
  USING (true);

CREATE POLICY "Service role can insert admin_settings"
  ON public.admin_settings FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role can update admin_settings"
  ON public.admin_settings FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role can delete admin_settings"
  ON public.admin_settings FOR DELETE
  USING (true);

-- =============================================
-- PART 4: AUTO-CREATE MISSING ADMIN_SETTINGS
-- =============================================

-- Auto-fulfillment for CodeCraft API (AT-iShare, Telecel, BigTime)
INSERT INTO public.admin_settings (key, value, description)
VALUES (
  'auto_fulfillment_enabled',
  '{"enabled": true, "networks": ["AT - iShare", "Telecel"]}',
  'Controls whether AT-iShare and Telecel orders are auto-fulfilled via Code Craft API or sent to admin queue'
)
ON CONFLICT (key) DO NOTHING;

-- MTN auto-fulfillment setting
INSERT INTO public.admin_settings (key, value, description)
VALUES (
  'mtn_auto_fulfillment_enabled',
  '{"enabled": false}',
  'Controls whether MTN orders are auto-fulfilled via MTN API or sent to admin queue'
)
ON CONFLICT (key) DO NOTHING;

-- MTN balance alert threshold
INSERT INTO public.admin_settings (key, value, description)
VALUES (
  'mtn_balance_alert_threshold',
  '{"threshold": 500}',
  'MTN wallet balance alert threshold (triggers alert when balance falls below this)'
)
ON CONFLICT (key) DO NOTHING;

-- Admin notification phones
INSERT INTO public.admin_settings (key, value, description)
VALUES (
  'admin_notification_phones',
  '{"phones": [], "description": "Admin phone numbers for SMS notifications on fulfillment failures"}',
  'List of admin phone numbers for critical notifications'
)
ON CONFLICT (key) DO NOTHING;

-- =============================================
-- VERIFICATION QUERIES
-- =============================================

-- Check app_settings RLS
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'app_settings';

-- Check admin_settings RLS
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'admin_settings';

-- Check app_settings policies
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'app_settings'
ORDER BY policyname;

-- Check admin_settings policies
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'admin_settings'
ORDER BY policyname;

-- Check admin_settings data
SELECT key, value, updated_at FROM public.admin_settings ORDER BY key;

-- Check app_settings data
SELECT 
  id,
  join_community_link,
  withdrawal_fee_percentage,
  paystack_fee_percentage,
  created_at,
  updated_at
FROM public.app_settings 
LIMIT 1;
