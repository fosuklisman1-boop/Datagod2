-- 0077_lockdown_authenticated_writes.sql
--
-- SECURITY — full reversal of the 0060 write over-grant (supersedes 0076).
--
-- Context: 0060_restore_public_grants granted `authenticated` INSERT/UPDATE/DELETE
-- on EVERY public table (+ default privileges for future tables), on the
-- assumption that some features write directly via the authenticated client. An
-- unauthorized pentest on 2026-06-21 abused this (forged orders, minted wallet
-- balance — see 0076). 0076 locked the financial/order subset; this migration
-- closes the systemic hole.
--
-- Verified before applying (grep of the whole codebase + mobile/):
--   * The web client only READS via the anon client (SELECT, RLS own-scoped).
--   * Every server write uses a SERVICE-ROLE client (local createClient with
--     SUPABASE_SERVICE_ROLE_KEY, or supabaseAdmin), which bypasses these grants.
--   * The ONLY direct authenticated write anywhere is the mobile app marking /
--     dismissing its own notifications (mobile/src/lib/notifications.ts) ->
--     notifications UPDATE/DELETE, which RLS already scopes to user_id = auth.uid().
--
-- So: revoke ALL authenticated/anon writes, keep ONLY notifications UPDATE/DELETE,
-- and reverse the default-privilege grant so new tables don't reopen the gap.
-- authenticated keeps SELECT (RLS still row-gates reads). service_role is
-- untouched (it is the trusted backend and bypasses RLS/grants).
--
-- Applied to production via the Supabase Management API on 2026-06-21; committed
-- here so the fix survives re-runs/resets and is reviewable.
--
-- ROLLBACK (if a legitimate client write surfaces): re-grant that single table,
-- e.g. `GRANT INSERT ON public.<table> TO authenticated;` — do NOT re-run 0060.

REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM authenticated, anon;

-- Sole client-direct-write path: mobile notification read/dismiss (own-row only).
GRANT UPDATE, DELETE ON public.notifications TO authenticated;

-- Stop FUTURE tables from auto-granting writes to app roles (reverse 0060's default).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM anon;

-- NOTE: when adding a table whose client writes directly (rare — prefer a
-- service-role API route), GRANT only the needed verb on that one table and add a
-- strict, content-constraining RLS WITH CHECK. Never rely on an ownership-only
-- INSERT policy for tables with money/price/status fields.
