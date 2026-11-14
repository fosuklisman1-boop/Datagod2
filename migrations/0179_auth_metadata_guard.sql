-- 0179: neutralise user-written auth metadata; block the 2026-11 probe domains; flag impersonating names.
--
-- WHY: auth.users.raw_user_meta_data is written by the user (supabase.auth.signUp options.data, or
-- supabase.auth.updateUser({ data }) at any time). Supabase cannot make it read-only, and the same
-- endpoint handles password/email changes, so it cannot be blocked. Probe accounts put
-- role "admin" / is_admin there (2026-06, 2026-11). App code no longer trusts it (0cfe0279), and
-- this makes the stored value itself trustworthy for the `role` key:
--   * BEFORE INSERT / UPDATE OF raw_user_meta_data on auth.users:
--       role     := public.users.role when the profile exists (the source of truth; the
--                   update-role route writes users first, then metadata, so server changes stick);
--                   on a brand-new account (no profile yet) only 'user' or 'sub_agent' (invite
--                   flow) are kept, anything else becomes 'user'.
--       is_admin := removed.
--     A privileged claim that gets overridden raises a 'metadata_tamper' security alert.
--     Never blocks a login: on any internal error it still strips both keys and returns.
--   * 'impersonation_name' alert (medium) when a signup metadata name or a public.users profile name
--     newly contains admin/support/datagod/staff/... (real admins exempt). Alert only, no block.
--   * reject_disposable_email: exact copy of the live function plus fldubai|bncinema.
--
-- Other metadata keys (names, phone_number, signup_source...) are left untouched.

BEGIN;

-- The backfill + trigger DDL lock auth.users until COMMIT; never queue logins for long.
SET LOCAL lock_timeout = '3s';

-- ── 1. Probe domains ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_disposable_email()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  dom text := lower(split_part(coalesce(NEW.email, ''), '@', 2));
BEGIN
  IF dom <> '' AND (
    dom ~ '(mailinator|tempmail|temp-mail|yopmail|guerrilla|sharklasers|trashmail|10minutemail|getnada|dispostable|maildrop|moakt|fakeinbox|throwaway|emailondeck|mintemail|discard|spam4|trbvm|tempr|wearehackerone|fldubai|bncinema)'
    OR dom IN ('test.com', 'example.com', 'example.org', 'example.net')
  ) THEN
    RAISE EXCEPTION 'disposable_email_blocked: temporary/disposable or test email providers are not allowed';
  END IF;
  RETURN NEW;
END;
$fn$;

-- ── 2. Helpers ──────────────────────────────────────────────────────────────────
-- Whole words only (\m \M), so "Badminton", "Staffordshire", "supportive" do not match.
CREATE OR REPLACE FUNCTION public.is_impersonating_name(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT coalesce(p, '') ~* '\m(admin|administrator|support|staff|official|moderator)\M|\mdatagod|\mcustomer\s*care\M|\mhelp\s*desk\M'
$fn$;

-- At most one alert per (category, user) per window: every alert is posted to the app by
-- security_alerts_notify_trg, so a looping attacker or a double trigger must not page repeatedly.
CREATE OR REPLACE FUNCTION public.raise_security_alert_once(
  p_severity text, p_category text, p_title text, p_detail jsonb, p_actor text, p_user uuid, p_window interval)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.security_alerts
    WHERE category = p_category AND created_at > now() - p_window AND detail->>'user_id' = p_user::text
  ) THEN
    RETURN;
  END IF;
  PERFORM public.raise_security_alert(p_severity, p_category, p_title, p_detail, p_actor);
END;
$fn$;

-- ── 3. Pin role / strip is_admin in auth metadata ───────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_users_pin_metadata()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_meta      jsonb := coalesce(NEW.raw_user_meta_data, '{}'::jsonb);
  v_old_meta  jsonb := CASE WHEN TG_OP = 'UPDATE' THEN coalesce(OLD.raw_user_meta_data, '{}'::jsonb) ELSE '{}'::jsonb END;
  v_claim     text  := lower(btrim(coalesce(v_meta->>'role', '')));
  v_claim_adm boolean := lower(coalesce(v_meta->>'is_admin', '')) IN ('true', 't', '1', 'yes');
  v_truth     text;
  v_role      text;
  v_name      text;
  v_old_name  text;
BEGIN
  SELECT u.role INTO v_truth FROM public.users u WHERE u.id = NEW.id;
  IF v_truth IS NOT NULL THEN
    v_role := v_truth;
  ELSIF v_claim IN ('user', 'sub_agent') THEN
    v_role := v_claim;
  ELSE
    v_role := 'user';
  END IF;

  NEW.raw_user_meta_data := (v_meta - 'is_admin') || jsonb_build_object('role', v_role);

  -- Tamper alert: an overridden claim that is not one of the harmless roles, or any is_admin=true.
  IF (v_claim <> '' AND v_claim <> v_role AND v_claim NOT IN ('user', 'sub_agent')) OR v_claim_adm THEN
    BEGIN
      PERFORM public.raise_security_alert_once(
        'high', 'metadata_tamper',
        'Auth metadata role claim overridden: ' || coalesce(NEW.email, NEW.id::text),
        jsonb_build_object('user_id', NEW.id, 'op', TG_OP, 'claimed_role', nullif(v_claim, ''),
                           'claimed_is_admin', v_claim_adm, 'pinned_role', v_role),
        coalesce(NEW.email, NEW.id::text), NEW.id, interval '1 hour');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  -- Impersonation alert on a NEW or CHANGED metadata name (not on every re-save).
  IF coalesce(v_truth, '') <> 'admin' THEN
    v_name := concat_ws(' ', v_meta->>'first_name', v_meta->>'last_name', v_meta->>'full_name', v_meta->>'name');
    v_old_name := concat_ws(' ', v_old_meta->>'first_name', v_old_meta->>'last_name', v_old_meta->>'full_name', v_old_meta->>'name');
    IF public.is_impersonating_name(v_name) AND v_name IS DISTINCT FROM v_old_name THEN
      BEGIN
        PERFORM public.raise_security_alert_once(
          'medium', 'impersonation_name',
          'Account name looks like staff/brand: ' || coalesce(NEW.email, NEW.id::text),
          jsonb_build_object('user_id', NEW.id, 'source', 'auth_metadata', 'name', left(v_name, 120)),
          coalesce(NEW.email, NEW.id::text), NEW.id, interval '1 day');
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block signup/login. Still remove the privileged keys, and leave a trace in the logs.
  RAISE WARNING 'auth_users_pin_metadata failed for %: %', NEW.id, SQLERRM;
  NEW.raw_user_meta_data := coalesce(NEW.raw_user_meta_data, '{}'::jsonb) - 'is_admin' - 'role';
  RETURN NEW;
END;
$fn$;

-- One-time silent cleanup BEFORE the trigger exists (so it raises no alerts). Prod precheck
-- 2026-11-14: 13 stale metadata 'dealer' on users.role 'user' (expired upgrades), 2 forged 'admin'
-- (suspended probes), 1 is_admin key. Rows with no role key are left alone.
DROP TRIGGER IF EXISTS auth_users_pin_metadata_trg ON auth.users;
UPDATE auth.users au
SET raw_user_meta_data = (au.raw_user_meta_data - 'is_admin') || jsonb_build_object('role', u.role)
FROM public.users u
WHERE u.id = au.id
  AND u.role IS NOT NULL
  AND au.raw_user_meta_data IS NOT NULL
  AND ((au.raw_user_meta_data ? 'role' AND au.raw_user_meta_data->>'role' IS DISTINCT FROM u.role)
       OR au.raw_user_meta_data ? 'is_admin');

CREATE TRIGGER auth_users_pin_metadata_trg
  BEFORE INSERT OR UPDATE OF raw_user_meta_data ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.auth_users_pin_metadata();

-- ── 4. Impersonation alert on public.users profile names ────────────────────────
CREATE OR REPLACE FUNCTION public.users_flag_impersonating_name()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_name text := concat_ws(' ', NEW.first_name, NEW.last_name, NEW.username);
  v_old  text := CASE WHEN TG_OP = 'UPDATE' THEN concat_ws(' ', OLD.first_name, OLD.last_name, OLD.username) ELSE NULL END;
BEGIN
  IF coalesce(NEW.role, '') <> 'admin' AND public.is_impersonating_name(v_name) AND v_name IS DISTINCT FROM v_old THEN
    PERFORM public.raise_security_alert_once(
      'medium', 'impersonation_name',
      'Account name looks like staff/brand: ' || coalesce(NEW.email, NEW.id::text),
      jsonb_build_object('user_id', NEW.id, 'source', 'profile', 'name', left(v_name, 120)),
      coalesce(NEW.email, NEW.id::text), NEW.id, interval '1 day');
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS users_flag_impersonating_name_trg ON public.users;
CREATE TRIGGER users_flag_impersonating_name_trg
  AFTER INSERT OR UPDATE OF first_name, last_name, username ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_flag_impersonating_name();

-- These run only as triggers; nobody calls them directly.
REVOKE ALL ON FUNCTION public.auth_users_pin_metadata() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.users_flag_impersonating_name() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.raise_security_alert_once(text, text, text, jsonb, text, uuid, interval) FROM PUBLIC, anon, authenticated;

COMMIT;
