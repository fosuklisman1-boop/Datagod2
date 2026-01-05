-- Fix RLS Auth Initialization Performance
-- Issue: auth.uid() is re-evaluated for each row, causing performance issues at scale
-- Solution: Wrap auth.uid() in a subquery (select auth.uid()) so it's evaluated once

-- Drop and recreate the shop_settings policies with optimized auth calls

-- Anyone can view shop settings (public storefront) - no auth needed
DROP POLICY IF EXISTS "Anyone can view shop settings" ON public.shop_settings;
CREATE POLICY "Anyone can view shop settings" ON public.shop_settings
  FOR SELECT
  USING (true);

-- Shop owner can update settings
DROP POLICY IF EXISTS "Shop owner can update settings" ON public.shop_settings;
CREATE POLICY "Shop owner can update settings" ON public.shop_settings
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_settings.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- Shop owner can insert settings
DROP POLICY IF EXISTS "Shop owner can insert settings" ON public.shop_settings;
CREATE POLICY "Shop owner can insert settings" ON public.shop_settings
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_settings.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- Shop owner can delete settings
DROP POLICY IF EXISTS "Shop owner can delete settings" ON public.shop_settings;
CREATE POLICY "Shop owner can delete settings" ON public.shop_settings
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_settings.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  );

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

-- shop_orders table (uses shop_id, not shop_owner_id)
DROP POLICY IF EXISTS "Shop owner can view orders" ON public.shop_orders;
CREATE POLICY "Shop owner can view orders" ON public.shop_orders
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_orders.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Shop owner can update orders" ON public.shop_orders;
CREATE POLICY "Shop owner can update orders" ON public.shop_orders
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_orders.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_orders.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- =============================================
-- WALLETS TABLE
-- =============================================
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
CREATE POLICY "Users can view own wallet" ON public.wallets
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update own wallet" ON public.wallets;
CREATE POLICY "Users can update own wallet" ON public.wallets
  FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can insert own wallet" ON public.wallets;
CREATE POLICY "Users can insert own wallet" ON public.wallets
  FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================
-- USER_SHOPS TABLE
-- =============================================
DROP POLICY IF EXISTS "Users can view their own shop" ON public.user_shops;
CREATE POLICY "Users can view their own shop" ON public.user_shops
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can create a shop" ON public.user_shops;
CREATE POLICY "Users can create a shop" ON public.user_shops
  FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update their own shop" ON public.user_shops;
CREATE POLICY "Users can update their own shop" ON public.user_shops
  FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================
-- SHOP_PACKAGES TABLE
-- =============================================
DROP POLICY IF EXISTS "Shop owners can view their packages" ON public.shop_packages;
CREATE POLICY "Shop owners can view their packages" ON public.shop_packages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_packages.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Shop owners can insert packages" ON public.shop_packages;
CREATE POLICY "Shop owners can insert packages" ON public.shop_packages
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_packages.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Shop owners can update packages" ON public.shop_packages;
CREATE POLICY "Shop owners can update packages" ON public.shop_packages
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_packages.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_packages.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Shop owners can delete packages" ON public.shop_packages;
CREATE POLICY "Shop owners can delete packages" ON public.shop_packages
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_packages.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- =============================================
-- SHOP_PROFITS TABLE
-- =============================================
DROP POLICY IF EXISTS "Shop owners can view their profits" ON public.shop_profits;
CREATE POLICY "Shop owners can view their profits" ON public.shop_profits
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_shops WHERE user_shops.id = shop_profits.shop_id AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- =============================================
-- WITHDRAWAL_REQUESTS TABLE
-- =============================================
DROP POLICY IF EXISTS "Users can view own withdrawals" ON public.withdrawal_requests;
CREATE POLICY "Users can view own withdrawals" ON public.withdrawal_requests
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can create withdrawals" ON public.withdrawal_requests;
CREATE POLICY "Users can create withdrawals" ON public.withdrawal_requests
  FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================
-- AFA_ORDERS TABLE
-- =============================================
DROP POLICY IF EXISTS "Users can view own afa orders" ON public.afa_orders;
CREATE POLICY "Users can view own afa orders" ON public.afa_orders
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can insert afa orders" ON public.afa_orders;
CREATE POLICY "Users can insert afa orders" ON public.afa_orders
  FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));
