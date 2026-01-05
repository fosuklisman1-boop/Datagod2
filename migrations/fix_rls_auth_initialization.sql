-- Fix RLS Auth Initialization Performance
-- Issue: auth.uid() is re-evaluated for each row, causing performance issues at scale
-- Solution: Wrap auth.uid() in a subquery (select auth.uid()) so it's evaluated once

-- Drop and recreate the shop_settings policies with optimized auth calls

-- Shop owner can update settings
DROP POLICY IF EXISTS "Shop owner can update settings" ON public.shop_settings;
CREATE POLICY "Shop owner can update settings" ON public.shop_settings
  FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Shop owner can view settings
DROP POLICY IF EXISTS "Shop owner can view settings" ON public.shop_settings;
CREATE POLICY "Shop owner can view settings" ON public.shop_settings
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- Shop owner can insert settings
DROP POLICY IF EXISTS "Shop owner can insert settings" ON public.shop_settings;
CREATE POLICY "Shop owner can insert settings" ON public.shop_settings
  FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Shop owner can delete settings
DROP POLICY IF EXISTS "Shop owner can delete settings" ON public.shop_settings;
CREATE POLICY "Shop owner can delete settings" ON public.shop_settings
  FOR DELETE
  USING (user_id = (SELECT auth.uid()));

-- Also fix any other tables that might have the same issue

-- users table
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT
  USING (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- orders table
DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
CREATE POLICY "Users can view own orders" ON public.orders
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can insert own orders" ON public.orders;
CREATE POLICY "Users can insert own orders" ON public.orders
  FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- wallet_transactions table
DROP POLICY IF EXISTS "Users can view own transactions" ON public.wallet_transactions;
CREATE POLICY "Users can view own transactions" ON public.wallet_transactions
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- complaints table
DROP POLICY IF EXISTS "Users can view own complaints" ON public.complaints;
CREATE POLICY "Users can view own complaints" ON public.complaints
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can insert own complaints" ON public.complaints;
CREATE POLICY "Users can insert own complaints" ON public.complaints
  FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- shop_orders table
DROP POLICY IF EXISTS "Shop owner can view orders" ON public.shop_orders;
CREATE POLICY "Shop owner can view orders" ON public.shop_orders
  FOR SELECT
  USING (shop_owner_id = (SELECT auth.uid()) OR customer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Shop owner can update orders" ON public.shop_orders;
CREATE POLICY "Shop owner can update orders" ON public.shop_orders
  FOR UPDATE
  USING (shop_owner_id = (SELECT auth.uid()))
  WITH CHECK (shop_owner_id = (SELECT auth.uid()));
