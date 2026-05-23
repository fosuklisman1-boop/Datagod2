-- =============================================
-- FIX WALLET RLS SECURITY
-- Removes the user-level UPDATE policy on wallets which allowed any
-- authenticated user to set their own balance to any value via the
-- anon key client. All wallet mutations must go through server-side
-- API routes (service role bypasses RLS) or SECURITY DEFINER functions.
-- =============================================

-- CRITICAL: Remove user UPDATE access on wallets
-- The service role key used in API routes handles all balance changes.
-- Removing this closes the direct-client balance manipulation backdoor.
DROP POLICY IF EXISTS "Users can update own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can update their own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Enable update for users based on user_id" ON public.wallets;

-- MEDIUM: Remove overly permissive INSERT on shop_customers
-- "WITH CHECK (true)" allows any anonymous user to insert. Service role
-- handles these inserts in API routes — no anon access needed.
DROP POLICY IF EXISTS "System can insert shop customers" ON public.shop_customers;
DROP POLICY IF EXISTS "System can update shop customers" ON public.shop_customers;

-- MEDIUM: Remove overly permissive INSERT on customer_tracking
DROP POLICY IF EXISTS "System can insert customer tracking" ON public.customer_tracking;

-- MEDIUM: Restrict fulfillment_logs — should be service-role only
-- Drop whatever blanket policy exists and replace with deny-all for anon.
DROP POLICY IF EXISTS "fulfillment_logs_policy" ON public.fulfillment_logs;
DROP POLICY IF EXISTS "Allow all operations on fulfillment_logs" ON public.fulfillment_logs;
DROP POLICY IF EXISTS "Enable all access for fulfillment_logs" ON public.fulfillment_logs;
-- Service role bypasses RLS entirely, so no replacement policy is needed.
-- If the table still needs RLS enabled verify with:
-- SELECT relrowsecurity FROM pg_class WHERE relname = 'fulfillment_logs';

-- =============================================
-- VERIFICATION QUERIES (run after applying)
-- =============================================
-- Check wallet policies (should show no UPDATE policy for authenticated users):
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'wallets';
--
-- Confirm wallet top-up still works via the app (uses service role in API routes).
