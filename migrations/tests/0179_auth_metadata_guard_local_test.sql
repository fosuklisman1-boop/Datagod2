-- LOCAL ONLY. Never run against production: it creates stub tables and an auth schema.
--
-- Exercises 0179_auth_metadata_guard.sql in an EMPTY database. Run from the repo root:
--   createdb meta_guard_test
--   psql -v ON_ERROR_STOP=1 -d meta_guard_test -f migrations/tests/0179_auth_metadata_guard_local_test.sql
-- (or the PGlite runner, see memory reference-pglite-sql-tests)
--
-- Passes when it prints AUTH_METADATA_GUARD_LOCAL_TEST_OK. Any failed ASSERT aborts.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb, last_sign_in_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.users (id uuid PRIMARY KEY, email text, role text, first_name text, last_name text, username text);
CREATE TABLE public.security_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(),
  severity text, category text, title text, detail jsonb, actor text, ip text, source text
);
-- Exact prod copy of raise_security_alert (0083).
CREATE FUNCTION public.raise_security_alert(p_severity text, p_category text, p_title text, p_detail jsonb DEFAULT '{}'::jsonb, p_actor text DEFAULT NULL::text, p_ip text DEFAULT NULL::text, p_source text DEFAULT 'trigger'::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE aid uuid; BEGIN
  INSERT INTO public.security_alerts(severity, category, title, detail, actor, ip, source)
  VALUES (p_severity, p_category, p_title, COALESCE(p_detail, '{}'::jsonb), p_actor, p_ip, p_source) RETURNING id INTO aid;
  RETURN aid; END; $f$;
-- Prod has reject_disposable_email attached to auth.users BEFORE INSERT; 0179 only replaces the function.
CREATE FUNCTION public.reject_disposable_email() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;
CREATE TRIGGER reject_disposable_email_trg BEFORE INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.reject_disposable_email();

-- Rows that exist BEFORE the migration (prod had 13 stale dealer, 2 forged admin, 1 is_admin).
INSERT INTO public.users (id, role) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'user'),
  ('00000000-0000-0000-0000-0000000000e2', 'user'),
  ('00000000-0000-0000-0000-0000000000e3', 'dealer');
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'old1@ok.com', '{"role":"dealer","first_name":"Yaw"}'),
  ('00000000-0000-0000-0000-0000000000e2', 'old2@ok.com', '{"role":"admin","is_admin":true}'),
  ('00000000-0000-0000-0000-0000000000e3', 'old3@ok.com', '{"first_name":"Esi"}');

\i migrations/0179_auth_metadata_guard.sql

DO $$ BEGIN
  ASSERT (SELECT raw_user_meta_data FROM auth.users WHERE id = '00000000-0000-0000-0000-0000000000e1')
         = '{"role":"user","first_name":"Yaw"}'::jsonb, 'backfill: stale dealer -> users.role, other keys kept';
  ASSERT (SELECT raw_user_meta_data FROM auth.users WHERE id = '00000000-0000-0000-0000-0000000000e2')
         = '{"role":"user"}'::jsonb, 'backfill: forged admin + is_admin cleaned';
  ASSERT (SELECT raw_user_meta_data FROM auth.users WHERE id = '00000000-0000-0000-0000-0000000000e3')
         = '{"first_name":"Esi"}'::jsonb, 'backfill: rows with no role key are left alone';
  ASSERT (SELECT count(*) FROM public.security_alerts) = 0, 'backfill raises no alerts';
END $$;

-- helpers
CREATE FUNCTION pg_temp.meta(p uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT raw_user_meta_data FROM auth.users WHERE id = p $$;
CREATE FUNCTION pg_temp.alerts(p_cat text) RETURNS int LANGUAGE sql AS $$ SELECT count(*)::int FROM public.security_alerts WHERE category = p_cat $$;

DO $$
DECLARE
  u1 uuid := '00000000-0000-0000-0000-000000000001';  -- self-signup claiming admin
  u2 uuid := '00000000-0000-0000-0000-000000000002';  -- invite sub-agent
  u3 uuid := '00000000-0000-0000-0000-000000000003';  -- existing plain user
  ua uuid := '00000000-0000-0000-0000-0000000000ad';  -- real admin
  u5 uuid := '00000000-0000-0000-0000-000000000005';  -- impersonating name
  m jsonb;
BEGIN
  -- 1. Signup claiming admin: pinned to user, is_admin removed, other keys kept, tamper alert.
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (u1, 'a@ok.com', '{"role":"admin","is_admin":true,"first_name":"Kofi","phone_number":"0240000001"}');
  m := pg_temp.meta(u1);
  ASSERT m->>'role' = 'user', format('1 role pinned, got %s', m);
  ASSERT NOT (m ? 'is_admin'), '1 is_admin stripped';
  ASSERT m->>'first_name' = 'Kofi' AND m->>'phone_number' = '0240000001', '1 harmless keys kept';
  ASSERT pg_temp.alerts('metadata_tamper') = 1, '1 tamper alert raised';

  -- 2. Invite flow: sub_agent at create is kept, no alert. Dealer claim at signup is NOT kept.
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (u2, 'b@ok.com', '{"role":"sub_agent"}');
  ASSERT pg_temp.meta(u2)->>'role' = 'sub_agent', '2 sub_agent kept on create';
  ASSERT pg_temp.alerts('metadata_tamper') = 1, '2 no alert for sub_agent';

  -- 3. Existing user edits own metadata to admin: pinned back to users.role, alert.
  INSERT INTO public.users (id, role) VALUES (u3, 'user');
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (u3, 'c@ok.com', '{"role":"user"}');
  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || '{"role":"admin"}' WHERE id = u3;
  ASSERT pg_temp.meta(u3)->>'role' = 'user', '3 pinned to users.role';
  ASSERT pg_temp.alerts('metadata_tamper') = 2, '3 alert';
  -- An attacker looping updateUser is still pinned every time, but alerts once per user per hour.
  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || '{"role":"admin","is_admin":true}' WHERE id = u3;
  ASSERT pg_temp.meta(u3)->>'role' = 'user' AND NOT (pg_temp.meta(u3) ? 'is_admin'), '3 repeat still pinned';
  ASSERT pg_temp.alerts('metadata_tamper') = 2, '3 repeat attempt does not re-alert within the hour';

  -- 4. Server role change (update-role order: users first, then metadata): kept, no alert.
  UPDATE public.users SET role = 'dealer' WHERE id = u3;
  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || '{"role":"dealer"}' WHERE id = u3;
  ASSERT pg_temp.meta(u3)->>'role' = 'dealer', '4 server role change sticks';
  ASSERT pg_temp.alerts('metadata_tamper') = 2, '4 no alert';

  -- 5. Real admin keeps admin, no alert.
  INSERT INTO public.users (id, role) VALUES (ua, 'admin');
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (ua, 'd@ok.com', '{"role":"admin"}');
  ASSERT pg_temp.meta(ua)->>'role' = 'admin', '5 real admin kept';
  ASSERT pg_temp.alerts('metadata_tamper') = 2, '5 no alert for a real admin';

  -- 6. Login-style update (other column) and a re-save of pinned metadata: no alert, no change.
  UPDATE auth.users SET last_sign_in_at = now() WHERE id = u3;
  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data WHERE id = u3;
  ASSERT pg_temp.alerts('metadata_tamper') = 2, '6 no alert on login/re-save';

  -- 7. Impersonating names: alert on signup metadata and on a profile name change; normal names none.
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (u5, 'e@ok.com', '{"full_name":"Datagod Support"}');
  ASSERT pg_temp.alerts('impersonation_name') = 1, '7 signup name alert';
  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data WHERE id = u5;
  ASSERT pg_temp.alerts('impersonation_name') = 1, '7 unchanged name does not re-alert';
  -- Same user again from the profile side (handle_new_user / profile edit): deduped for a day.
  INSERT INTO public.users (id, role, first_name) VALUES (u5, 'user', 'Ama');
  UPDATE public.users SET first_name = 'Admin', last_name = 'QA' WHERE id = u5;
  ASSERT pg_temp.alerts('impersonation_name') = 1, '7 one alert per user per day';
  -- A different user changing their profile name does alert.
  UPDATE public.users SET first_name = 'Customer Care' WHERE id = u3;
  ASSERT pg_temp.alerts('impersonation_name') = 2, '7 profile name alert';
  -- Whole words only: real names that merely contain the letters do not alert.
  UPDATE public.users SET first_name = 'Badminton', last_name = 'Staffordshire', username = 'supportive_kofi' WHERE id = u2;
  ASSERT pg_temp.alerts('impersonation_name') = 2, '7 substrings do not alert';
  -- A real admin may use such words.
  UPDATE public.users SET first_name = 'Datagod Admin' WHERE id = ua;
  ASSERT pg_temp.alerts('impersonation_name') = 2, '7 real admin exempt';

  -- 8. Probe domains blocked at signup; normal domain allowed.
  BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (gen_random_uuid(), 'x@fldubai.com', '{}');
    RAISE EXCEPTION 'fldubai not blocked';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM LIKE 'disposable_email_blocked%', format('8 fldubai: %s', SQLERRM);
  END;
  BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (gen_random_uuid(), 'x@bncinema.com', '{}');
    RAISE EXCEPTION 'bncinema not blocked';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM LIKE 'disposable_email_blocked%', format('8 bncinema: %s', SQLERRM);
  END;
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (gen_random_uuid(), 'kofi@gmail.com', '{}');

  RAISE NOTICE 'AUTH_METADATA_GUARD_LOCAL_TEST_OK';
END $$;
