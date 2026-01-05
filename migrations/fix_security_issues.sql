-- =============================================
-- FIX SECURITY ISSUES
-- =============================================

-- =============================================
-- FIX SECURITY DEFINER VIEWS
-- These views bypass RLS - change to SECURITY INVOKER
-- =============================================

-- Fix wallet_summary view
DROP VIEW IF EXISTS public.wallet_summary;
CREATE OR REPLACE VIEW public.wallet_summary 
WITH (security_invoker = true)
AS
SELECT 
  w.user_id,
  w.balance,
  u.email
FROM wallets w
LEFT JOIN users u ON w.user_id = u.id;

-- Fix payment_summary view
DROP VIEW IF EXISTS public.payment_summary;
CREATE OR REPLACE VIEW public.payment_summary
WITH (security_invoker = true)
AS
SELECT 
  o.id,
  o.user_id,
  o.total_amount,
  o.status,
  o.created_at,
  u.email
FROM orders o
LEFT JOIN users u ON o.user_id = u.id;

-- =============================================
-- ENABLE RLS ON TABLES WITHOUT IT
-- =============================================

-- shop_available_balance table
ALTER TABLE public.shop_available_balance ENABLE ROW LEVEL SECURITY;

-- Allow shop owners to view their own balance
DROP POLICY IF EXISTS "Shop owners can view their balance" ON public.shop_available_balance;
CREATE POLICY "Shop owners can view their balance" ON public.shop_available_balance
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_available_balance.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- support_settings table
ALTER TABLE public.support_settings ENABLE ROW LEVEL SECURITY;

-- Anyone can read support settings (public info like WhatsApp link)
DROP POLICY IF EXISTS "Anyone can view support settings" ON public.support_settings;
CREATE POLICY "Anyone can view support settings" ON public.support_settings
  FOR SELECT
  USING (true);

-- Only admins can modify support settings (using service role in API)
