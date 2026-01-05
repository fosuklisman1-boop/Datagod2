-- =============================================
-- COMPREHENSIVE RLS AUTH OPTIMIZATION
-- =============================================
-- This script drops ALL existing RLS policies and recreates them
-- with optimized (SELECT auth.uid()) instead of auth.uid()

-- =============================================
-- USERS TABLE - Drop all old policies first
-- =============================================
DROP POLICY IF EXISTS "Users can read their own data" ON public.users;
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
DROP POLICY IF EXISTS "Users can update their own data" ON public.users;
DROP POLICY IF EXISTS "Users can insert their own data" ON public.users;
DROP POLICY IF EXISTS "Enable read access for users" ON public.users;
DROP POLICY IF EXISTS "Enable update for users based on id" ON public.users;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.users;

CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT USING (id = (SELECT auth.uid()));

CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- =============================================
-- ORDERS TABLE - Drop all old policies first
-- =============================================
DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can insert own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can read their own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can create their own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can update their own orders" ON public.orders;
DROP POLICY IF EXISTS "Enable read access for users" ON public.orders;
DROP POLICY IF EXISTS "Enable insert for authenticated users" ON public.orders;

CREATE POLICY "Users can view own orders" ON public.orders
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert own orders" ON public.orders
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can update own orders" ON public.orders
  FOR UPDATE USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================
-- WALLETS TABLE - Drop all old policies first
-- =============================================
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can update own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can insert own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can read their own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can update their own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Enable read access for users" ON public.wallets;
DROP POLICY IF EXISTS "Enable update for users based on user_id" ON public.wallets;

CREATE POLICY "Users can view own wallet" ON public.wallets
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can update own wallet" ON public.wallets
  FOR UPDATE USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert own wallet" ON public.wallets
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================
-- WALLET_TRANSACTIONS TABLE
-- =============================================
DROP POLICY IF EXISTS "Users can view own transactions" ON public.wallet_transactions;
DROP POLICY IF EXISTS "Users can read their own transactions" ON public.wallet_transactions;
DROP POLICY IF EXISTS "Enable read access for users" ON public.wallet_transactions;

CREATE POLICY "Users can view own transactions" ON public.wallet_transactions
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- =============================================
-- COMPLAINTS TABLE
-- =============================================
DROP POLICY IF EXISTS "Users can view own complaints" ON public.complaints;
DROP POLICY IF EXISTS "Users can insert own complaints" ON public.complaints;
DROP POLICY IF EXISTS "Users can read their own complaints" ON public.complaints;
DROP POLICY IF EXISTS "Users can create complaints" ON public.complaints;
DROP POLICY IF EXISTS "Enable read access for users" ON public.complaints;

CREATE POLICY "Users can view own complaints" ON public.complaints
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert own complaints" ON public.complaints
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================
-- AFA_ORDERS TABLE
-- =============================================
DROP POLICY IF EXISTS "Users can view own afa orders" ON public.afa_orders;
DROP POLICY IF EXISTS "Users can insert afa orders" ON public.afa_orders;
DROP POLICY IF EXISTS "Users can read their own afa orders" ON public.afa_orders;
DROP POLICY IF EXISTS "Enable read access for users" ON public.afa_orders;

CREATE POLICY "Users can view own afa orders" ON public.afa_orders
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert afa orders" ON public.afa_orders
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================
-- USER_SHOPS TABLE
-- =============================================
DROP POLICY IF EXISTS "Users can view their own shop" ON public.user_shops;
DROP POLICY IF EXISTS "Users can create a shop" ON public.user_shops;
DROP POLICY IF EXISTS "Users can update their own shop" ON public.user_shops;
DROP POLICY IF EXISTS "Anyone can view shops" ON public.user_shops;
DROP POLICY IF EXISTS "Shop owners can manage their shop" ON public.user_shops;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.user_shops;

-- Anyone can view shops (for public storefronts)
CREATE POLICY "Anyone can view shops" ON public.user_shops
  FOR SELECT USING (true);

CREATE POLICY "Users can create a shop" ON public.user_shops
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can update their own shop" ON public.user_shops
  FOR UPDATE USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================
-- SHOP_SETTINGS TABLE
-- =============================================
DROP POLICY IF EXISTS "Anyone can view shop settings" ON public.shop_settings;
DROP POLICY IF EXISTS "Shop owner can update settings" ON public.shop_settings;
DROP POLICY IF EXISTS "Shop owner can insert settings" ON public.shop_settings;
DROP POLICY IF EXISTS "Shop owner can delete settings" ON public.shop_settings;

CREATE POLICY "Anyone can view shop settings" ON public.shop_settings
  FOR SELECT USING (true);

CREATE POLICY "Shop owner can update settings" ON public.shop_settings
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_settings.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  );

CREATE POLICY "Shop owner can insert settings" ON public.shop_settings
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_settings.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  );

CREATE POLICY "Shop owner can delete settings" ON public.shop_settings
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_settings.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  );

-- =============================================
-- SHOP_PACKAGES TABLE
-- =============================================
DROP POLICY IF EXISTS "Shop owners can view their packages" ON public.shop_packages;
DROP POLICY IF EXISTS "Shop owners can insert packages" ON public.shop_packages;
DROP POLICY IF EXISTS "Shop owners can update packages" ON public.shop_packages;
DROP POLICY IF EXISTS "Shop owners can delete packages" ON public.shop_packages;
DROP POLICY IF EXISTS "Anyone can view shop packages" ON public.shop_packages;
DROP POLICY IF EXISTS "Public can view available packages" ON public.shop_packages;

-- Anyone can view shop packages (for public storefronts)
CREATE POLICY "Anyone can view shop packages" ON public.shop_packages
  FOR SELECT USING (true);

CREATE POLICY "Shop owners can insert packages" ON public.shop_packages
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_packages.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  );

CREATE POLICY "Shop owners can update packages" ON public.shop_packages
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_packages.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_packages.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  );

CREATE POLICY "Shop owners can delete packages" ON public.shop_packages
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_packages.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  );

-- =============================================
-- SHOP_ORDERS TABLE
-- =============================================
DROP POLICY IF EXISTS "Shop owner can view orders" ON public.shop_orders;
DROP POLICY IF EXISTS "Shop owner can update orders" ON public.shop_orders;
DROP POLICY IF EXISTS "Anyone can create shop orders" ON public.shop_orders;
DROP POLICY IF EXISTS "Public can create orders" ON public.shop_orders;

-- Anyone can create shop orders (customers placing orders)
CREATE POLICY "Anyone can create shop orders" ON public.shop_orders
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Shop owner can view orders" ON public.shop_orders
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_orders.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  );

CREATE POLICY "Shop owner can update orders" ON public.shop_orders
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_orders.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_orders.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  );

-- =============================================
-- SHOP_PROFITS TABLE
-- =============================================
DROP POLICY IF EXISTS "Shop owners can view their profits" ON public.shop_profits;
DROP POLICY IF EXISTS "Shop owner can view profits" ON public.shop_profits;

CREATE POLICY "Shop owners can view their profits" ON public.shop_profits
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_shops WHERE user_shops.id = shop_profits.shop_id AND user_shops.user_id = (SELECT auth.uid()))
  );

-- =============================================
-- WITHDRAWAL_REQUESTS TABLE
-- =============================================
DROP POLICY IF EXISTS "Users can view own withdrawals" ON public.withdrawal_requests;
DROP POLICY IF EXISTS "Users can create withdrawals" ON public.withdrawal_requests;
DROP POLICY IF EXISTS "Users can read their own withdrawals" ON public.withdrawal_requests;

CREATE POLICY "Users can view own withdrawals" ON public.withdrawal_requests
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can create withdrawals" ON public.withdrawal_requests
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================
-- PACKAGES TABLE (if RLS enabled)
-- =============================================
DROP POLICY IF EXISTS "Anyone can view packages" ON public.packages;
DROP POLICY IF EXISTS "Public can view packages" ON public.packages;

CREATE POLICY "Anyone can view packages" ON public.packages
  FOR SELECT USING (true);

-- =============================================
-- SMS_LOGS TABLE (if exists)
-- =============================================
DROP POLICY IF EXISTS "Users can view own sms logs" ON public.sms_logs;

CREATE POLICY "Users can view own sms logs" ON public.sms_logs
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- =============================================
-- FULFILLMENT_LOGS TABLE (if exists)
-- =============================================
DROP POLICY IF EXISTS "Users can view own fulfillment logs" ON public.fulfillment_logs;

CREATE POLICY "Users can view own fulfillment logs" ON public.fulfillment_logs
  FOR SELECT USING (user_id = (SELECT auth.uid()));
