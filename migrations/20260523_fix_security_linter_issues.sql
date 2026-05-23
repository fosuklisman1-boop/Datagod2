-- =============================================
-- Fix Supabase Security Linter Issues
-- 1. Change SECURITY DEFINER views to SECURITY INVOKER
-- 2. Enable RLS on 5 public tables
-- =============================================

-- =============================================
-- PART 1: Fix Security Definer Views
-- Views were running as the definer (superuser), bypassing RLS
-- on underlying tables for any caller. Switching to SECURITY
-- INVOKER makes queries run as the calling user, so existing
-- RLS on orders/api_orders/shop_orders etc. is respected.
-- All app routes querying these views use service_role, which
-- bypasses RLS server-side — so this change is safe.
-- =============================================

ALTER VIEW public.combined_orders_view SET (security_invoker = true);
ALTER VIEW public.broadcast_stats_view SET (security_invoker = true);

-- =============================================
-- PART 2: Re-enable RLS on airtime_orders
-- Disabled in fix_airtime_rls.sql for debugging, never re-enabled.
-- Existing policies are retained; update SELECT policy to use
-- the (SELECT auth.uid()) init-plan pattern for performance.
-- =============================================

ALTER TABLE public.airtime_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own airtime orders" ON public.airtime_orders;
CREATE POLICY "Users can view own airtime orders"
  ON public.airtime_orders FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- =============================================
-- PART 3: Enable RLS on ussd_afa_orders
-- Anonymous USSD registrations — no user_id column.
-- Only admins (via authenticated role) and service_role
-- (which bypasses RLS automatically) should access this data.
-- =============================================

ALTER TABLE public.ussd_afa_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage ussd afa orders"
  ON public.ussd_afa_orders FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );

-- =============================================
-- PART 4: Enable RLS on mtn_fulfillment_tracking
-- Internal tracking rows linked to shop_orders.
-- Shop owners can read their own tracking rows.
-- Admins can do everything. Mutations are service_role only.
-- =============================================

ALTER TABLE public.mtn_fulfillment_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Shop owners can view their fulfillment tracking"
  ON public.mtn_fulfillment_tracking FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.shop_orders so
      JOIN public.user_shops us ON so.shop_id = us.id
      WHERE so.id = mtn_fulfillment_tracking.shop_order_id
        AND us.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Admins can manage fulfillment tracking"
  ON public.mtn_fulfillment_tracking FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );

-- =============================================
-- PART 5: Enable RLS on subscription_reminders
-- Pure backend deduplication table — no user-facing query path.
-- Enabling RLS with no policies for authenticated/anon blocks
-- all direct PostgREST access; service_role bypasses RLS.
-- =============================================

ALTER TABLE public.subscription_reminders ENABLE ROW LEVEL SECURITY;

-- =============================================
-- PART 6: Enable RLS on blacklisted_phone_numbers
-- Admin-only management table.
-- =============================================

ALTER TABLE public.blacklisted_phone_numbers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage blacklisted phone numbers"
  ON public.blacklisted_phone_numbers FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role = 'admin')
  );
