-- Fix shop_profits RLS policies to prevent unauthorized manipulation
--
-- Problem: The UPDATE policy uses USING (true) WITH CHECK (true), meaning
-- any authenticated user can update any profit record to any value.
-- The INSERT policy also allows shop owners to insert arbitrary profit amounts.
--
-- Fix: Block direct INSERT and UPDATE from authenticated users entirely.
-- All writes go through the service role key (backend API), which bypasses RLS.

-- Drop existing overly permissive policies
DROP POLICY IF EXISTS "Users can insert profits for their shops" ON public.shop_profits;
DROP POLICY IF EXISTS "System can update profits" ON public.shop_profits;
DROP POLICY IF EXISTS "System can update profit records" ON public.shop_profits;
DROP POLICY IF EXISTS "System can create profit records" ON public.shop_profits;

-- INSERT: Block direct inserts from authenticated users.
-- The backend uses the service role key which bypasses RLS, so this only
-- blocks direct Supabase client calls from the frontend/users.
CREATE POLICY "System only can insert profits"
  ON public.shop_profits FOR INSERT
  WITH CHECK (false);

-- UPDATE: Block direct updates from authenticated users.
CREATE POLICY "System only can update profits"
  ON public.shop_profits FOR UPDATE
  USING (false)
  WITH CHECK (false);
