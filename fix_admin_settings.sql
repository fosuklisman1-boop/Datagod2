-- =============================================
-- FIX ADMIN_SETTINGS TABLE RLS POLICIES
-- =============================================
-- This migration fixes RLS policies for admin_settings to enable proper UPSERT operations
-- The table stores key-value configuration for admin features (MTN fulfillment, etc.)

-- =============================================
-- STEP 1: Drop all existing policies
-- =============================================
DROP POLICY IF EXISTS "Admins can read settings" ON public.admin_settings;
DROP POLICY IF EXISTS "Admins can update settings" ON public.admin_settings;
DROP POLICY IF EXISTS "Admins can insert settings" ON public.admin_settings;
DROP POLICY IF EXISTS "Admins can delete settings" ON public.admin_settings;
DROP POLICY IF EXISTS "Service role can manage admin_settings" ON public.admin_settings;

-- =============================================
-- STEP 2: Ensure RLS is enabled
-- =============================================
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;

-- =============================================
-- STEP 3: Create new RLS policies
-- =============================================

-- Policy 1: Service role (API backend with service role key) can SELECT admin_settings
-- This allows reading settings from API routes
CREATE POLICY "Service role can read admin_settings"
  ON public.admin_settings FOR SELECT
  USING (true);

-- Policy 2: Service role (API backend with service role key) can INSERT admin_settings
-- This allows UPSERT to work (UPSERT needs INSERT permission)
CREATE POLICY "Service role can insert admin_settings"
  ON public.admin_settings FOR INSERT
  WITH CHECK (true);

-- Policy 3: Service role (API backend with service role key) can UPDATE admin_settings
-- This allows UPSERT to work (UPSERT needs UPDATE permission)
CREATE POLICY "Service role can update admin_settings"
  ON public.admin_settings FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Policy 4: Service role (API backend with service role key) can DELETE admin_settings
-- This allows deletion if needed
CREATE POLICY "Service role can delete admin_settings"
  ON public.admin_settings FOR DELETE
  USING (true);

-- =============================================
-- STEP 5: Ensure default admin settings exist
-- =============================================
-- Insert MTN auto-fulfillment setting if not exists
INSERT INTO public.admin_settings (key, value, description)
VALUES (
  'mtn_auto_fulfillment_enabled',
  '{"enabled": false}',
  'Controls whether MTN orders are auto-fulfilled via MTN API or sent to admin queue'
)
ON CONFLICT (key) DO NOTHING;

-- Insert general auto-fulfillment setting if not exists
INSERT INTO public.admin_settings (key, value, description)
VALUES (
  'auto_fulfillment_enabled',
  '{"enabled": true, "networks": ["AT - iShare", "Telecel"]}',
  'Controls whether AT-iShare and Telecel orders are auto-fulfilled via Code Craft API or sent to admin queue'
)
ON CONFLICT (key) DO NOTHING;

-- =============================================
-- VERIFICATION
-- =============================================
-- Check RLS is enabled
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'admin_settings';

-- Check policies
SELECT schemaname, tablename, policyname, permissive
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'admin_settings'
ORDER BY policyname;

-- Check settings exist
SELECT key, value, updated_at FROM public.admin_settings ORDER BY key;
