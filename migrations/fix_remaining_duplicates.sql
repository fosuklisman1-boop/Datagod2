-- =============================================
-- FIX REMAINING DUPLICATE POLICIES
-- shop_invites and sub_agent_catalog
-- =============================================

-- =============================================
-- SHOP_INVITES - Fix overlapping policies
-- =============================================

-- Drop all existing policies
DROP POLICY IF EXISTS "Anyone can read invite by code" ON public.shop_invites;
DROP POLICY IF EXISTS "Shop owners can manage invites" ON public.shop_invites;

-- Create single SELECT policy that covers both cases
CREATE POLICY "Anyone can read invites" ON public.shop_invites
  FOR SELECT USING (true);

-- Separate policies for INSERT/UPDATE/DELETE (not SELECT)
CREATE POLICY "Shop owners can insert invites" ON public.shop_invites
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_invites.inviter_shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Shop owners can update invites" ON public.shop_invites
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_invites.inviter_shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Shop owners can delete invites" ON public.shop_invites
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = shop_invites.inviter_shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- =============================================
-- SUB_AGENT_CATALOG - Combine into single SELECT policy
-- =============================================

-- Drop all existing policies
DROP POLICY IF EXISTS "Shop owners can manage their catalog" ON public.sub_agent_catalog;
DROP POLICY IF EXISTS "Sub-agents can read parent catalog" ON public.sub_agent_catalog;

-- Single SELECT policy: shop owner OR sub-agent can read
CREATE POLICY "Owners and sub-agents can view catalog" ON public.sub_agent_catalog
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = sub_agent_catalog.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
    OR
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.parent_shop_id = sub_agent_catalog.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- INSERT/UPDATE/DELETE only for shop owners
CREATE POLICY "Shop owners can insert catalog" ON public.sub_agent_catalog
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = sub_agent_catalog.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Shop owners can update catalog" ON public.sub_agent_catalog
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = sub_agent_catalog.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Shop owners can delete catalog" ON public.sub_agent_catalog
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_shops 
      WHERE user_shops.id = sub_agent_catalog.shop_id 
      AND user_shops.user_id = (SELECT auth.uid())
    )
  );

-- =============================================
-- DONE
-- =============================================
