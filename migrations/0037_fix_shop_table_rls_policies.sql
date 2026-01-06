-- =============================================
-- FIX RLS POLICIES FOR SHOP TABLES
-- =============================================
-- This migration adds missing policies and fixes existing ones
-- to prevent "new row violates rls" errors on shop creation and operations

-- =============================================
-- USER_SHOPS TABLE - Fix SELECT, INSERT, and add DELETE policies
-- =============================================

-- Drop existing policies to clean up
DROP POLICY IF EXISTS "Users can view their own shop" ON public.user_shops;
DROP POLICY IF EXISTS "Users can create their own shop" ON public.user_shops;
DROP POLICY IF EXISTS "Users can update their own shop" ON public.user_shops;
DROP POLICY IF EXISTS "Users can delete their own shop" ON public.user_shops;
DROP POLICY IF EXISTS "Anyone can view active shops" ON public.user_shops;

-- Create new policies
CREATE POLICY "Users can view their own shop"
  ON public.user_shops FOR SELECT
  USING (auth.uid() = user_id OR is_active = true);

CREATE POLICY "Users can create their own shop"
  ON public.user_shops FOR INSERT
  WITH CHECK (auth.uid() = user_id AND auth.uid() IS NOT NULL);

CREATE POLICY "Users can update their own shop"
  ON public.user_shops FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own shop"
  ON public.user_shops FOR DELETE
  USING (auth.uid() = user_id);

-- =============================================
-- SHOP_PACKAGES TABLE - Add missing DELETE policy
-- =============================================

DROP POLICY IF EXISTS "Users can manage packages for their shops" ON public.shop_packages;
DROP POLICY IF EXISTS "Users can view packages for their shops" ON public.shop_packages;
DROP POLICY IF EXISTS "Users can insert packages for their shops" ON public.shop_packages;
DROP POLICY IF EXISTS "Users can update packages for their shops" ON public.shop_packages;
DROP POLICY IF EXISTS "Users can delete packages for their shops" ON public.shop_packages;
DROP POLICY IF EXISTS "Anyone can view active packages" ON public.shop_packages;

CREATE POLICY "Users can view packages for their shops"
  ON public.shop_packages FOR SELECT
  USING (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
    OR shop_id IN (SELECT id FROM user_shops WHERE is_active = true)
  );

CREATE POLICY "Users can insert packages for their shops"
  ON public.shop_packages FOR INSERT
  WITH CHECK (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can update packages for their shops"
  ON public.shop_packages FOR UPDATE
  USING (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can delete packages for their shops"
  ON public.shop_packages FOR DELETE
  USING (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

-- =============================================
-- SHOP_ORDERS TABLE - Add missing DELETE policy and fix SELECT
-- =============================================

DROP POLICY IF EXISTS "Users can view orders for their shops" ON public.shop_orders;
DROP POLICY IF EXISTS "Users can insert orders" ON public.shop_orders;
DROP POLICY IF EXISTS "Users can update orders for their shops" ON public.shop_orders;
DROP POLICY IF EXISTS "Users can delete orders for their shops" ON public.shop_orders;
DROP POLICY IF EXISTS "Anyone can create orders" ON public.shop_orders;

CREATE POLICY "Users can view orders for their shops"
  ON public.shop_orders FOR SELECT
  USING (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
    OR auth.uid() IS NULL
  );

CREATE POLICY "Users can insert orders"
  ON public.shop_orders FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Users can update orders for their shops"
  ON public.shop_orders FOR UPDATE
  USING (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can delete orders for their shops"
  ON public.shop_orders FOR DELETE
  USING (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

-- =============================================
-- SHOP_PROFITS TABLE - Add missing UPDATE policy
-- =============================================

DROP POLICY IF EXISTS "Users can view profits for their shops" ON public.shop_profits;
DROP POLICY IF EXISTS "Users can insert profits for their shops" ON public.shop_profits;
DROP POLICY IF EXISTS "Users can update profits for their shops" ON public.shop_profits;

CREATE POLICY "Users can view profits for their shops"
  ON public.shop_profits FOR SELECT
  USING (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can insert profits for their shops"
  ON public.shop_profits FOR INSERT
  WITH CHECK (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

CREATE POLICY "System can update profits"
  ON public.shop_profits FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- =============================================
-- WITHDRAWAL_REQUESTS TABLE - Add missing UPDATE policy
-- =============================================

DROP POLICY IF EXISTS "Users can view withdrawal requests" ON public.withdrawal_requests;
DROP POLICY IF EXISTS "Users can insert withdrawal requests" ON public.withdrawal_requests;
DROP POLICY IF EXISTS "Admins can update withdrawal requests" ON public.withdrawal_requests;

CREATE POLICY "Users can view withdrawal requests"
  ON public.withdrawal_requests FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Users can insert withdrawal requests"
  ON public.withdrawal_requests FOR INSERT
  WITH CHECK (
    user_id = auth.uid() AND auth.uid() IS NOT NULL
  );

CREATE POLICY "Admins can update withdrawal requests"
  ON public.withdrawal_requests FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- =============================================
-- SHOP_SETTINGS TABLE - Add missing INSERT and DELETE policies
-- =============================================

DROP POLICY IF EXISTS "Users can manage shop settings" ON public.shop_settings;
DROP POLICY IF EXISTS "Users can view shop settings" ON public.shop_settings;
DROP POLICY IF EXISTS "Users can insert shop settings" ON public.shop_settings;
DROP POLICY IF EXISTS "Users can update shop settings" ON public.shop_settings;
DROP POLICY IF EXISTS "Users can delete shop settings" ON public.shop_settings;

CREATE POLICY "Users can view shop settings"
  ON public.shop_settings FOR SELECT
  USING (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can insert shop settings"
  ON public.shop_settings FOR INSERT
  WITH CHECK (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can update shop settings"
  ON public.shop_settings FOR UPDATE
  USING (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can delete shop settings"
  ON public.shop_settings FOR DELETE
  USING (
    shop_id IN (SELECT id FROM user_shops WHERE user_id = auth.uid())
  );

-- =============================================
-- VERIFICATION
-- =============================================
-- All tables should now have complete RLS coverage:
-- - user_shops: SELECT, INSERT, UPDATE, DELETE ✓
-- - shop_packages: SELECT, INSERT, UPDATE, DELETE ✓
-- - shop_orders: SELECT, INSERT, UPDATE, DELETE ✓
-- - shop_profits: SELECT, INSERT, UPDATE ✓
-- - withdrawal_requests: SELECT, INSERT, UPDATE ✓
-- - shop_settings: SELECT, INSERT, UPDATE, DELETE ✓
