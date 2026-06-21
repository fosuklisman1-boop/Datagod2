-- 0078_revoke_truncate_references_trigger.sql
--
-- SECURITY — completes the 0077 lockdown.
--
-- 0077 revoked INSERT/UPDATE/DELETE from authenticated/anon, but the older
-- GRANT ALL (pre-0060) had also handed those roles TRUNCATE, REFERENCES, and
-- TRIGGER on public tables. RLS does NOT gate TRUNCATE, and these aren't
-- exposed through PostgREST today (the REST API can't truncate / alter schema),
-- so they're not exploitable via the normal Supabase API surface — but there's
-- no reason for app roles to hold them. Surfaced 2026-06-21 while auditing a
-- live, ongoing pentest that was probing privilege escalation.
--
-- After this, authenticated/anon retain ONLY SELECT on public tables (plus the
-- notifications UPDATE/DELETE carve-out from 0077). Applied live via the
-- Management API on 2026-06-21.

REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated, anon;
