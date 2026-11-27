-- 0201_phone_login.sql
--
-- Phone + password login with a new-device SMS code, Task 1: schema, lookup RPC, lockout RPCs, revoke-all triggers, settings.
-- NOT applied by the implementing agent. One transaction. Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS).
--
--   ghana_phone_sig(text)            IMMUTABLE; same rules as ghanaSignificant in lib/phone-format.ts. Expression index on public.users.
--   phone_login_find_account(text)   always exactly one row; user columns are filled only when exactly one account has that sig.
--   phone_login_events               fail / lockout / login_ok / ... rows (the spec's phone_login_failures, widened for admin counts).
--   phone_login_record_failure/_is_locked   5 failed attempts per phone_hash in 15 min locks it.
--   phone_login_challenges, trusted_devices  new-device code state and remembered browsers.
--   Triggers revoke every live trusted device of a user when: password changes, user is banned, phone changes, user is suspended.
--   admin_settings: phone_login_enabled='false', phone_login_new_device_code='true' (insert only, never overwrites).
--
-- All three tables have RLS on with no policies and no grants to anon/authenticated: service_role (BYPASSRLS) only.
-- Every function is SECURITY DEFINER with search_path = '' and EXECUTE for service_role only.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.users'), to_regclass('auth.users'), to_regclass('public.admin_settings');   -- all NOT NULL
--   SELECT to_regclass('public.phone_login_events');                                                      -- NULL (first run)
--
-- VERIFY after applying:
--   SELECT public.ghana_phone_sig('+233 24 123 4567');                                                     -- 241234567
--   SELECT relrowsecurity FROM pg_class WHERE relname IN ('phone_login_events','phone_login_challenges','trusted_devices');  -- t, t, t
--   SELECT key, value FROM public.admin_settings WHERE key LIKE 'phone_login_%';                           -- 2 rows
--
-- Undo: DROP the three triggers (trg_phone_login_*), the functions, the three tables and users_phone_sig_idx; DELETE the two settings rows.
-- Dry run: migrations/0201_phone_login.selftest.sql (build the run string by code, lib/phone-login/migration-0201-run.ts).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------------------------------------------------
-- Phone signature + expression index
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ghana_phone_sig(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $fn$
  SELECT CASE WHEN d ~ '^[2-9][0-9]{8}$' THEN d ELSE NULL END
  FROM (
    SELECT CASE
             WHEN s LIKE '233%' THEN substr(s, 4)
             WHEN s LIKE '0%'   THEN substr(s, 2)
             ELSE s
           END AS d
    FROM (SELECT pg_catalog.regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') AS s) x
  ) y
$fn$;

CREATE INDEX IF NOT EXISTS users_phone_sig_idx ON public.users (public.ghana_phone_sig(phone_number));

-- ---------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phone_login_events (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('fail','lockout','login_ok','challenge_sent','challenge_passed','password_changed','code_switch_off')),
  user_id    uuid NULL,
  phone_hash text NULL,
  ip_hash    text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_login_events_phone_idx ON public.phone_login_events (phone_hash, created_at);
CREATE INDEX IF NOT EXISTS phone_login_events_ip_idx    ON public.phone_login_events (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS phone_login_events_kind_idx  ON public.phone_login_events (kind, created_at);

CREATE TABLE IF NOT EXISTS public.phone_login_challenges (
  id                  text PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  browser_secret_hash text NOT NULL,
  otp_phone           text NOT NULL,
  attempts            int  NOT NULL DEFAULT 0,
  last_sent_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz NULL
);

CREATE TABLE IF NOT EXISTS public.trusted_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  ua_label     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz NULL
);
CREATE INDEX IF NOT EXISTS trusted_devices_user_live_idx ON public.trusted_devices (user_id) WHERE revoked_at IS NULL;

ALTER TABLE public.phone_login_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phone_login_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trusted_devices        ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.phone_login_events, public.phone_login_challenges, public.trusted_devices FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.phone_login_events, public.phone_login_challenges, public.trusted_devices TO service_role;
REVOKE ALL ON SEQUENCE public.phone_login_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON SEQUENCE public.phone_login_events_id_seq TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- Lookup + lockout RPCs
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phone_login_find_account(p_sig text)
RETURNS TABLE (match_count int, user_id uuid, email text, phone_number text, phone_verified boolean, is_suspended boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_count int;
BEGIN
  SELECT count(*)::int INTO v_count FROM public.users u WHERE public.ghana_phone_sig(u.phone_number) = p_sig;

  IF v_count = 1 THEN
    RETURN QUERY
      SELECT 1, u.id, au.email::text, u.phone_number, u.phone_verified, u.is_suspended
        FROM public.users u
        LEFT JOIN auth.users au ON au.id = u.id
       WHERE public.ghana_phone_sig(u.phone_number) = p_sig;
  ELSE
    RETURN QUERY SELECT v_count, NULL::uuid, NULL::text, NULL::text, NULL::boolean, NULL::boolean;
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.phone_login_record_failure(p_phone_hash text, p_ip_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_n int;
BEGIN
  -- serialise per phone so exactly one lockout row is written when the count reaches 5
  PERFORM pg_advisory_xact_lock(hashtext('phone_login:' || coalesce(p_phone_hash, '')));
  INSERT INTO public.phone_login_events (kind, phone_hash, ip_hash) VALUES ('fail', p_phone_hash, p_ip_hash);
  SELECT count(*)::int INTO v_n FROM public.phone_login_events
   WHERE kind = 'fail' AND phone_hash = p_phone_hash AND created_at > now() - interval '15 minutes';
  IF v_n = 5 THEN
    INSERT INTO public.phone_login_events (kind, phone_hash, ip_hash) VALUES ('lockout', p_phone_hash, p_ip_hash);
  END IF;
  RETURN v_n >= 5;
END
$fn$;

CREATE OR REPLACE FUNCTION public.phone_login_is_locked(p_phone_hash text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT count(*) >= 5 FROM public.phone_login_events
   WHERE kind = 'fail' AND phone_hash = p_phone_hash AND created_at > now() - interval '15 minutes'
$fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Revoke-all triggers
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phone_login_revoke_devices()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.trusted_devices SET revoked_at = now() WHERE user_id = NEW.id AND revoked_at IS NULL;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.phone_login_password_changed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.trusted_devices SET revoked_at = now() WHERE user_id = NEW.id AND revoked_at IS NULL;
  INSERT INTO public.phone_login_events (kind, user_id) VALUES ('password_changed', NEW.id);
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_phone_login_password ON auth.users;
CREATE TRIGGER trg_phone_login_password AFTER UPDATE ON auth.users
  FOR EACH ROW WHEN (OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password)
  EXECUTE FUNCTION public.phone_login_password_changed();

DROP TRIGGER IF EXISTS trg_phone_login_ban ON auth.users;
CREATE TRIGGER trg_phone_login_ban AFTER UPDATE ON auth.users
  FOR EACH ROW WHEN (NEW.banned_until IS NOT NULL AND OLD.banned_until IS DISTINCT FROM NEW.banned_until)
  EXECUTE FUNCTION public.phone_login_revoke_devices();

DROP TRIGGER IF EXISTS trg_phone_login_user ON public.users;
CREATE TRIGGER trg_phone_login_user AFTER UPDATE ON public.users
  FOR EACH ROW WHEN (OLD.phone_number IS DISTINCT FROM NEW.phone_number
                     OR (NEW.is_suspended IS TRUE AND OLD.is_suspended IS DISTINCT FROM TRUE))
  EXECUTE FUNCTION public.phone_login_revoke_devices();

-- ---------------------------------------------------------------------------------------------------------------------
-- Function privileges: service_role only
-- ---------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ghana_phone_sig(text)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_login_find_account(text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_login_record_failure(text, text)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_login_is_locked(text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_login_revoke_devices()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phone_login_password_changed()              FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ghana_phone_sig(text)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_login_find_account(text)           TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_login_record_failure(text, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_login_is_locked(text)              TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_login_revoke_devices()             TO service_role;
GRANT EXECUTE ON FUNCTION public.phone_login_password_changed()           TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- Settings (insert only; an existing row is never overwritten)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO public.admin_settings (key, value) VALUES ('phone_login_enabled', 'false') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.admin_settings (key, value) VALUES ('phone_login_new_device_code', 'true') ON CONFLICT (key) DO NOTHING;

COMMIT;
