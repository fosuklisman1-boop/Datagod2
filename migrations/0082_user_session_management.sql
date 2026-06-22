-- 0082_user_session_management.sql
--
-- Backs the "Active Sessions" panel on /dashboard/profile (previously a hardcoded
-- "You have 1 active session" placeholder). The browser cannot read auth.sessions
-- (PostgREST only exposes the public schema), so we expose three SECURITY DEFINER
-- helpers and revoke EXECUTE from app roles — only the service-role client (in
-- app/api/auth/sessions/route.ts, after authenticating the caller) may invoke
-- them, and every call is scoped to the caller's own user id.
--
-- Applied live via the Management API 2026-06-22.

-- List a user's active sessions (device, IP, created/last-active).
CREATE OR REPLACE FUNCTION public.get_user_sessions(p_uid uuid)
RETURNS TABLE(id uuid, created_at timestamptz, last_active timestamptz, ip text, user_agent text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $f1$
  SELECT s.id,
         s.created_at,
         COALESCE(s.refreshed_at, s.updated_at, s.created_at) AS last_active,
         host(s.ip)::text AS ip,
         s.user_agent
  FROM auth.sessions s
  WHERE s.user_id = p_uid
  ORDER BY COALESCE(s.refreshed_at, s.updated_at, s.created_at) DESC;
$f1$;
REVOKE EXECUTE ON FUNCTION public.get_user_sessions(uuid) FROM public, anon, authenticated;

-- Revoke every session for a user except the one we keep (the current device).
-- p_keep NULL revokes all sessions.
CREATE OR REPLACE FUNCTION public.revoke_other_user_sessions(p_uid uuid, p_keep uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $f2$
DECLARE n integer;
BEGIN
  DELETE FROM auth.sessions WHERE user_id = p_uid AND (p_keep IS NULL OR id <> p_keep);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$f2$;
REVOKE EXECUTE ON FUNCTION public.revoke_other_user_sessions(uuid, uuid) FROM public, anon, authenticated;

-- Revoke a single session, scoped to the caller's user id (so a user can never
-- end another account's session even by guessing its id).
CREATE OR REPLACE FUNCTION public.revoke_user_session(p_uid uuid, p_session uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $f3$
DECLARE n integer;
BEGIN
  DELETE FROM auth.sessions WHERE user_id = p_uid AND id = p_session;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$f3$;
REVOKE EXECUTE ON FUNCTION public.revoke_user_session(uuid, uuid) FROM public, anon, authenticated;
