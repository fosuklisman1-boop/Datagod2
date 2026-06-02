-- 0057_restore_users_grants_and_policies.sql
--
-- ROOT CAUSE of the two symptoms:
--   1. "permission denied for table users" when changing a phone number.
--      /api/user/update-phone runs as service_role. The manual RLS lockdown
--      REVOKEd table privileges from service_role. service_role's BYPASSRLS
--      attribute skips POLICY checks but NOT privilege (GRANT) checks, so a
--      missing GRANT still yields 42501.
--   2. PhoneRequiredModal never fires. It read public.users as the
--      `authenticated` role. public.users has RLS enabled but — unlike
--      transactions / notifications / wallet_payments / airtime_orders — there
--      is NO own-row SELECT policy. With RLS on and no SELECT policy, the read
--      returns 0 rows (NOT an error), so the gate logic saw "no profile" and
--      stayed hidden. (The app now reads this via /api/user/me using
--      service_role, so step 1 alone makes the gate work; steps 2-3 restore the
--      normal authenticated path too.)
--
-- Safe to run multiple times.

-- 1. service_role: full access. THIS is the one that fixes the phone-number
--    UPDATE. RLS never applies to service_role; it just needs the GRANT back.
GRANT ALL ON TABLE public.users TO service_role;

-- 2. authenticated: may read/update its own row (RLS scopes it to that row).
GRANT SELECT, UPDATE ON TABLE public.users TO authenticated;

-- 3. The missing own-row SELECT policy. Without this, authenticated reads of
--    public.users return 0 rows even with the GRANT in place.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT
  TO authenticated
  USING (id = (SELECT auth.uid()));

-- NOTE: the own-row UPDATE policy is intentionally NOT recreated here — migration
-- 0045 defines an anti-recursion version (SECURITY DEFINER role lookup) that
-- forbids role self-escalation. Leave it as-is.

-- ───────────────────────────────────────────────────────────────────────────
-- VERIFY (run these SELECTs after the above; eyeball the output):
--
--   -- (a) grants present?
--   SELECT grantee, privilege_type
--     FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name = 'users'
--      AND grantee IN ('service_role','authenticated')
--    ORDER BY grantee, privilege_type;
--   -- expect: authenticated -> SELECT, UPDATE ;
--   --         service_role  -> DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
--   -- (b) own-row SELECT policy present?
--   SELECT policyname, cmd, roles
--     FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'users'
--    ORDER BY policyname;
--   -- expect a row: "Users can view own profile" | SELECT | {authenticated}
-- ───────────────────────────────────────────────────────────────────────────
