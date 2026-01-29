-- =============================================
-- FIX APP_SETTINGS TABLE RLS POLICIES
-- =============================================
-- This migration sets up proper RLS policies for app_settings
-- The table should be readable by everyone but only admins can modify it
-- IMPORTANT: Uses service role key from API routes, not user auth

-- =============================================
-- STEP 1: Drop all existing policies
-- =============================================
DROP POLICY IF EXISTS "Anyone can read app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Admins can insert app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Admins can update app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Admins can delete app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Users can read app settings" ON public.app_settings;
DROP POLICY IF EXISTS "System can manage app settings" ON public.app_settings;
DROP POLICY IF EXISTS "Service role can manage app_settings" ON public.app_settings;

-- =============================================
-- STEP 2: Ensure RLS is enabled
-- =============================================
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- =============================================
-- STEP 3: Create new RLS policies
-- =============================================

-- Policy 1: Anyone can READ app_settings (public settings)
CREATE POLICY "Anyone can read app_settings"
  ON public.app_settings FOR SELECT
  USING (true);

-- Policy 2: Service role (API backend) can INSERT app_settings
-- This policy allows INSERT via the service role key (used in API routes)
CREATE POLICY "Service role can insert app_settings"
  ON public.app_settings FOR INSERT
  WITH CHECK (true);

-- Policy 3: Service role (API backend) can UPDATE app_settings
-- This policy allows UPDATE via the service role key (used in API routes)
CREATE POLICY "Service role can update app_settings"
  ON public.app_settings FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Policy 4: Service role (API backend) can DELETE app_settings
-- This policy allows DELETE via the service role key (used in API routes)
CREATE POLICY "Service role can delete app_settings"
  ON public.app_settings FOR DELETE
  USING (true);

-- =============================================
-- STEP 4: Ensure default values are set properly (optional cleanup)
-- =============================================
-- Update any NULL values to proper defaults
UPDATE public.app_settings
SET 
  join_community_link = COALESCE(join_community_link, ''),
  announcement_enabled = COALESCE(announcement_enabled, false),
  announcement_title = COALESCE(announcement_title, ''),
  announcement_message = COALESCE(announcement_message, ''),
  christmas_theme_enabled = COALESCE(christmas_theme_enabled, false),
  paystack_fee_percentage = COALESCE(paystack_fee_percentage, 3.0),
  wallet_topup_fee_percentage = COALESCE(wallet_topup_fee_percentage, 0.0),
  withdrawal_fee_percentage = COALESCE(withdrawal_fee_percentage, 0.0),
  price_adjustment_mtn = COALESCE(price_adjustment_mtn, 0),
  price_adjustment_telecel = COALESCE(price_adjustment_telecel, 0),
  price_adjustment_at_ishare = COALESCE(price_adjustment_at_ishare, 0),
  price_adjustment_at_bigtime = COALESCE(price_adjustment_at_bigtime, 0),
  updated_at = now()
WHERE id IS NOT NULL;

-- =============================================
-- STEP 5: Create a default row if none exists
-- =============================================
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
-- VERIFICATION
-- =============================================
-- Check RLS is enabled
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'app_settings';

-- Check policies
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'app_settings'
ORDER BY policyname;

-- Check data exists
SELECT COUNT(*) as settings_count FROM public.app_settings;
SELECT * FROM public.app_settings LIMIT 1;
