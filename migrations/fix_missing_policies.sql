-- =============================================
-- FIX MISSING POLICIES
-- Re-adds policies that may have been dropped during migration
-- Safe to run - uses DROP IF EXISTS before CREATE
-- =============================================

-- complaints policies
DROP POLICY IF EXISTS "Users can view own complaints" ON public.complaints;
CREATE POLICY "Users can view own complaints" ON public.complaints
  FOR SELECT USING (
    user_id = (SELECT auth.uid()) 
    OR 
    EXISTS (SELECT 1 FROM users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );

DROP POLICY IF EXISTS "Users can insert own complaints" ON public.complaints;
CREATE POLICY "Users can insert own complaints" ON public.complaints
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- Allow admins to update any complaint
DROP POLICY IF EXISTS "Admins can update complaints" ON public.complaints;
CREATE POLICY "Admins can update complaints" ON public.complaints
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );

-- afa_orders policies
DROP POLICY IF EXISTS "Users can view own afa orders" ON public.afa_orders;
CREATE POLICY "Users can view own afa orders" ON public.afa_orders
  FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can insert afa orders" ON public.afa_orders;
CREATE POLICY "Users can insert afa orders" ON public.afa_orders
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- shop_packages - ensure owners can still manage their packages
DROP POLICY IF EXISTS "Shop owners can insert packages" ON public.shop_packages;
CREATE POLICY "Shop owners can insert packages" ON public.shop_packages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_packages.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Shop owners can update packages" ON public.shop_packages;
CREATE POLICY "Shop owners can update packages" ON public.shop_packages
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_packages.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Shop owners can delete packages" ON public.shop_packages;
CREATE POLICY "Shop owners can delete packages" ON public.shop_packages
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_packages.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- shop_orders - ensure policies exist
DROP POLICY IF EXISTS "Shop owner can view orders" ON public.shop_orders;
CREATE POLICY "Shop owner can view orders" ON public.shop_orders
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_orders.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Shop owner can update orders" ON public.shop_orders;
CREATE POLICY "Shop owner can update orders" ON public.shop_orders
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_orders.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Anyone can create shop orders" ON public.shop_orders;
CREATE POLICY "Anyone can create shop orders" ON public.shop_orders
  FOR INSERT WITH CHECK (true);

-- withdrawal_requests - ensure SELECT and INSERT exist
DROP POLICY IF EXISTS "Users can view own withdrawals" ON public.withdrawal_requests;
CREATE POLICY "Users can view own withdrawals" ON public.withdrawal_requests
  FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can create withdrawals" ON public.withdrawal_requests;
CREATE POLICY "Users can create withdrawals" ON public.withdrawal_requests
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================
-- DONE - All essential policies restored
-- =============================================
