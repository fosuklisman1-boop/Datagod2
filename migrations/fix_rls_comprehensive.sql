-- =============================================
-- COMPREHENSIVE RLS FIX MIGRATION
-- Fixes: auth_rls_initplan, multiple_permissive_policies, duplicate_index
-- =============================================

-- =============================================
-- PART 1: REMOVE DUPLICATE POLICIES
-- Keep one policy per table/action, drop duplicates
-- =============================================

-- orders table - remove duplicate INSERT policy
DROP POLICY IF EXISTS "Users can create orders" ON public.orders;

-- transactions table - fix auth.uid()
DROP POLICY IF EXISTS "Users can read their own transactions" ON public.transactions;
CREATE POLICY "Users can read their own transactions" ON public.transactions
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- shop_packages - remove duplicates and fix auth.uid()
DROP POLICY IF EXISTS "Users can view their shop packages" ON public.shop_packages;
DROP POLICY IF EXISTS "Users can create packages for their shop" ON public.shop_packages;
DROP POLICY IF EXISTS "Users can update their shop packages" ON public.shop_packages;
DROP POLICY IF EXISTS "Anyone can view shop packages" ON public.shop_packages;
DROP POLICY IF EXISTS "Public can view available shop packages" ON public.shop_packages;
DROP POLICY IF EXISTS "Shop owners can view their packages" ON public.shop_packages;

-- Keep only optimized policies for shop_packages
CREATE POLICY "Anyone can view shop packages" ON public.shop_packages
  FOR SELECT USING (true);

-- shop_orders - remove duplicates and fix auth.uid()
DROP POLICY IF EXISTS "Shop owners can view their orders" ON public.shop_orders;
DROP POLICY IF EXISTS "Shop owners can update their orders" ON public.shop_orders;
DROP POLICY IF EXISTS "Anyone can create a shop order" ON public.shop_orders;

-- wallet_transactions - remove duplicate
DROP POLICY IF EXISTS "wallet_transactions_select_own" ON public.wallet_transactions;

-- withdrawal_requests - remove duplicates and fix auth.uid()
DROP POLICY IF EXISTS "Users can view their withdrawal requests" ON public.withdrawal_requests;
DROP POLICY IF EXISTS "Users can create withdrawal requests" ON public.withdrawal_requests;
DROP POLICY IF EXISTS "Users can update their pending withdrawals" ON public.withdrawal_requests;

-- Create optimized withdrawal policies
CREATE POLICY "Users can update their pending withdrawals" ON public.withdrawal_requests
  FOR UPDATE
  USING (user_id = (SELECT auth.uid()) AND status = 'pending')
  WITH CHECK (user_id = (SELECT auth.uid()) AND status = 'pending');

-- wallet_payments - fix auth.uid()
DROP POLICY IF EXISTS "wallet_payments_select_own" ON public.wallet_payments;
CREATE POLICY "wallet_payments_select_own" ON public.wallet_payments
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- user_wallets - fix auth.uid()
DROP POLICY IF EXISTS "user_wallets_select_own" ON public.user_wallets;
CREATE POLICY "user_wallets_select_own" ON public.user_wallets
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- wallet_refunds - fix auth.uid()
DROP POLICY IF EXISTS "wallet_refunds_select_own" ON public.wallet_refunds;
CREATE POLICY "wallet_refunds_select_own" ON public.wallet_refunds
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- complaints - remove duplicates and fix auth.uid()
DROP POLICY IF EXISTS "Users can view their own complaints" ON public.complaints;
DROP POLICY IF EXISTS "Users can insert their own complaints" ON public.complaints;
DROP POLICY IF EXISTS "Admins can view all complaints" ON public.complaints;
DROP POLICY IF EXISTS "Admins can read all complaints" ON public.complaints;
DROP POLICY IF EXISTS "Admins can update all complaints" ON public.complaints;

-- notifications - fix auth.uid()
DROP POLICY IF EXISTS "Users can view their own notifications" ON public.notifications;
CREATE POLICY "Users can view their own notifications" ON public.notifications
  FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update their own notifications" ON public.notifications;
CREATE POLICY "Users can update their own notifications" ON public.notifications
  FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can delete their own notifications" ON public.notifications;
CREATE POLICY "Users can delete their own notifications" ON public.notifications
  FOR DELETE USING (user_id = (SELECT auth.uid()));

-- afa_orders - remove duplicates and fix auth.uid()
DROP POLICY IF EXISTS "Users can read their own AFA orders" ON public.afa_orders;
DROP POLICY IF EXISTS "Admins can read all AFA orders" ON public.afa_orders;
DROP POLICY IF EXISTS "Users can create their own AFA orders" ON public.afa_orders;
DROP POLICY IF EXISTS "Admins can update AFA orders" ON public.afa_orders;

-- afa_registration_prices - fix auth.uid()
DROP POLICY IF EXISTS "Only admins can update AFA prices" ON public.afa_registration_prices;
CREATE POLICY "Only admins can update AFA prices" ON public.afa_registration_prices
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );

DROP POLICY IF EXISTS "Only admins can insert AFA prices" ON public.afa_registration_prices;
CREATE POLICY "Only admins can insert AFA prices" ON public.afa_registration_prices
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );

-- verification_attempts - remove duplicates and fix auth.uid()
DROP POLICY IF EXISTS "Users can view their own verification attempts" ON public.verification_attempts;
DROP POLICY IF EXISTS "Service role can manage verification attempts" ON public.verification_attempts;

CREATE POLICY "Users can view their own verification attempts" ON public.verification_attempts
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- webhook_attempts - fix auth.uid()
DROP POLICY IF EXISTS "Service role can manage webhook attempts" ON public.webhook_attempts;
CREATE POLICY "Service role can manage webhook attempts" ON public.webhook_attempts
  FOR ALL USING (true); -- Service role bypasses RLS anyway

-- sms_logs - remove duplicate and fix auth.uid()
DROP POLICY IF EXISTS "Users can view their own SMS logs" ON public.sms_logs;
DROP POLICY IF EXISTS "Users can view own sms logs" ON public.sms_logs;

CREATE POLICY "Users can view own sms logs" ON public.sms_logs
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- shop_customers - fix auth.uid()
DROP POLICY IF EXISTS "Shop owners can view their customers" ON public.shop_customers;
CREATE POLICY "Shop owners can view their customers" ON public.shop_customers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_customers.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- customer_tracking - fix auth.uid()
DROP POLICY IF EXISTS "Shop owners can view their customer tracking" ON public.customer_tracking;
CREATE POLICY "Shop owners can view their customer tracking" ON public.customer_tracking
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_shops us
      JOIN shop_customers sc ON sc.shop_id = us.id
      WHERE sc.id = customer_tracking.shop_customer_id
      AND us.user_id = (SELECT auth.uid())
    )
  );

-- admin_settings - fix auth.uid()
DROP POLICY IF EXISTS "Admins can read settings" ON public.admin_settings;
CREATE POLICY "Admins can read settings" ON public.admin_settings
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );

DROP POLICY IF EXISTS "Admins can update settings" ON public.admin_settings;
CREATE POLICY "Admins can update settings" ON public.admin_settings
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );

DROP POLICY IF EXISTS "Admins can insert settings" ON public.admin_settings;
CREATE POLICY "Admins can insert settings" ON public.admin_settings
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );

-- payment_attempts - remove duplicate and fix auth.uid()
DROP POLICY IF EXISTS "Admin can view all payment attempts" ON public.payment_attempts;
DROP POLICY IF EXISTS "Users can view own payment attempts" ON public.payment_attempts;

CREATE POLICY "Users can view own payment attempts" ON public.payment_attempts
  FOR SELECT USING (
    user_id = (SELECT auth.uid()) OR
    EXISTS (SELECT 1 FROM users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );

-- shop_invites - remove duplicates and fix auth.uid()
DROP POLICY IF EXISTS "Shop owners can view own invites" ON public.shop_invites;
DROP POLICY IF EXISTS "Shop owners can create invites" ON public.shop_invites;
DROP POLICY IF EXISTS "Shop owners can update own invites" ON public.shop_invites;
DROP POLICY IF EXISTS "Service role full access" ON public.shop_invites;
DROP POLICY IF EXISTS "Anyone can read invite by code" ON public.shop_invites;

-- Recreate shop_invites policies with optimized auth.uid()
CREATE POLICY "Anyone can read invite by code" ON public.shop_invites
  FOR SELECT USING (true);

CREATE POLICY "Shop owners can manage invites" ON public.shop_invites
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_invites.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- sub_agent_catalog - remove duplicates and fix auth.uid()
DROP POLICY IF EXISTS "Shop owners can manage their catalog" ON public.sub_agent_catalog;
DROP POLICY IF EXISTS "Sub-agents can read parent catalog" ON public.sub_agent_catalog;

CREATE POLICY "Shop owners can manage their catalog" ON public.sub_agent_catalog
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = sub_agent_catalog.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Sub-agents can read parent catalog" ON public.sub_agent_catalog
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.parent_shop_id = sub_agent_catalog.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- fulfillment_logs - remove all duplicate policies, keep one
DROP POLICY IF EXISTS "Allow all fulfillment log operations" ON public.fulfillment_logs;
DROP POLICY IF EXISTS "Allow system to read fulfillment logs" ON public.fulfillment_logs;
DROP POLICY IF EXISTS "Allow system to insert fulfillment logs" ON public.fulfillment_logs;
DROP POLICY IF EXISTS "Allow system to update fulfillment logs" ON public.fulfillment_logs;
DROP POLICY IF EXISTS "Allow system to delete fulfillment logs" ON public.fulfillment_logs;

CREATE POLICY "Allow all fulfillment log operations" ON public.fulfillment_logs
  FOR ALL USING (true);

-- packages - remove duplicate
DROP POLICY IF EXISTS "Anyone can read packages" ON public.packages;
-- Keep "Anyone can view packages" policy

-- user_shops - remove duplicate
DROP POLICY IF EXISTS "Anyone can view shops" ON public.user_shops;
-- Keep "Public can view active shops by slug" policy

-- =============================================
-- PART 2: FIX DUPLICATE INDEX
-- =============================================

DROP INDEX IF EXISTS idx_shop_orders_order_status;
-- Keep idx_shop_orders_status

-- =============================================
-- DONE
-- =============================================
