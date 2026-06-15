-- 20260615_fix_shop_invites_read.sql
--
-- SECURITY FIX (MEDIUM) — shop_invites readable by any authenticated user.
--
-- ROOT CAUSE
-- shop_invites has a SELECT policy "Anyone can read invites" with roles {public}
-- and USING (true). With 0060's blanket grant, any logged-in user can
-- `GET /rest/v1/shop_invites?select=*` and read EVERY invite row: the secret
-- invite_code (a short bearer token), inviter_shop_id, status, expires_at, and the
-- stored phone (email column). Because the acceptance endpoint
-- app/api/shop/invites/[code]/route.ts gates only on code + expiry + status, a
-- leaked pending code lets an attacker self-provision as a sub_agent under that
-- inviter (discounted wholesale pricing) and deny the legitimate invitee.
--
-- FIX
-- The legitimate join/accept flow uses the SERVICE-ROLE API route (bypasses RLS),
-- and shop owners read their own invites scoped by inviter_shop_id ownership. So
-- replace the open read with an owner-scoped SELECT (mirrors the existing
-- "Shop owners can insert/update/delete invites" predicate). Random authenticated
-- users can no longer enumerate invite codes.

BEGIN;

DROP POLICY IF EXISTS "Anyone can read invites" ON shop_invites;
DROP POLICY IF EXISTS "Anyone can read invite by code" ON shop_invites;

CREATE POLICY "Shop owners can read their invites"
  ON shop_invites FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_shops
      WHERE user_shops.id = shop_invites.inviter_shop_id
        AND user_shops.user_id = (SELECT auth.uid())
    )
  );

COMMIT;
