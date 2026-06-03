-- 0060_restore_public_grants.sql
--
-- ROOT fix for the recurring "permission denied for table X" (42501): users, then
-- shop_packages, then user_shops (shop creation), ... The manual RLS lockdown
-- REVOKEd table GRANTs from the standard roles across the WHOLE public schema, so
-- every feature whose client writes directly (authenticated) — or whose backend
-- uses service_role — hits 42501 until its table is re-granted, one at a time.
--
-- This restores Supabase's standard posture in ONE pass: roles HAVE table grants,
-- and RLS policies decide WHICH rows. service_role is the trusted backend (bypasses
-- RLS); authenticated gets CRUD but is still gated to its own rows by RLS.
--
-- anon is intentionally NOT re-granted: the storefront's public reads were moved to
-- curated service_role API endpoints (/api/public/*), so guests need no direct
-- table access. Add specific anon GRANTs only if a public path actually requires one.

-- service_role: full access everywhere. The lockdown should never have touched it.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- authenticated: standard CRUD. RLS still decides which rows it may touch.
-- (Functions are intentionally NOT blanket-granted to authenticated — sensitive
--  RPCs like credit_wallet_safely stay locked; grant those individually if needed.)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- FUTURE tables/sequences inherit these, so the next migration can't silently
-- reintroduce the gap. (Applies to objects created by the role running this.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- REVIEW after running — tables WITHOUT RLS are now fully readable/writable by ANY
-- authenticated user (no row gate). Enable RLS + policies on any that hold other
-- users' or sensitive data:
--   SELECT relname AS table_without_rls
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
--    ORDER BY relname;
--
-- If a write now fails with "new row violates row-level security policy" (NOT
-- 42501), that table simply lacks an INSERT/UPDATE POLICY — a different fix. Tell me
-- the table and I'll add the owner policy.
-- ───────────────────────────────────────────────────────────────────────────
