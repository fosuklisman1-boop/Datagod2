-- 0088_fix_shop_rls_cross_tenant_read.sql
--
-- Pentest finding (2026-06-22): any AUTHENTICATED user could read every row of
-- user_shops (1,149 rows: owner UUIDs, markups, internal flags) and shop_settings
-- (449 rows: commission_rate, notification_email, whatsapp_link) cross-tenant.
-- Cause: user_shops SELECT policy allowed `is_active = true` (all shops), and
-- shop_settings had a `USING (true)` "Anyone can view settings" policy.
--
-- Fix: scope authenticated SELECT to the owner. SAFE because anon has NO SELECT
-- GRANT on these tables (verified), so the public storefront + sitemap already
-- read them via SERVICE-ROLE (RLS-exempt) — e.g. lib/sms/shop-context-service.ts
-- (supabaseAdmin). Owners still read their own rows (dashboard reads filter by
-- user_id / own shop). Applied live via the Management API 2026-06-22.

-- user_shops: authenticated reads only their own shop (was: own OR any active).
DROP POLICY IF EXISTS "Users can view own shop or public active shops" ON public.user_shops;
CREATE POLICY "user_shops_owner_select" ON public.user_shops
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- shop_settings: authenticated reads only settings for shops they own (was: any).
DROP POLICY IF EXISTS "Anyone can view settings" ON public.shop_settings;
CREATE POLICY "shop_settings_owner_select" ON public.shop_settings
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_shops us
    WHERE us.id = shop_settings.shop_id
      AND us.user_id = (SELECT auth.uid())
  ));
