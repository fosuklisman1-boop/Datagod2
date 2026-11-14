-- 0178: tenant_global_settings admin policy must not trust user_metadata.
--
-- WHY: 0065 created tgs_admin_write as
--   EXISTS (SELECT 1 FROM auth.users WHERE id = auth.uid() AND raw_user_meta_data->>'role' = 'admin')
-- raw_user_meta_data is written by the user (supabase.auth.signUp options.data, or
-- supabase.auth.updateUser({ data }) at any time), so any signed-in account can satisfy it.
-- Probe accounts with a forged metadata role "admin" exist in prod (2026-06, 2026-11).
-- Today `authenticated` only holds SELECT on this table, so the policy cannot write anything,
-- but a future GRANT would silently open the platform SMS settings to every user.
-- public.users.role is the source of truth (verifyAdminAccess reads only that).
--
-- Idempotent. Reads stay governed by the existing select policy (unchanged).

BEGIN;

DROP POLICY IF EXISTS tgs_admin_write ON public.tenant_global_settings;

CREATE POLICY tgs_admin_write ON public.tenant_global_settings
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'));

-- Self-check: no policy in public may consult user_metadata for authorization any more.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual, '') ~* 'raw_user_meta_data|user_metadata'
        OR coalesce(with_check, '') ~* 'raw_user_meta_data|user_metadata')
  ) THEN
    RAISE EXCEPTION '0178: a public policy still reads user metadata';
  END IF;
END $$;

COMMIT;
