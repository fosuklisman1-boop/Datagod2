-- 0201_phone_login.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0201_phone_login.sql.
--
-- IMPORTANT: the run string must be built by CODE (lib/phone-login/migration-0201-run.ts), never by hand: it keeps BEGIN and
-- both SET LOCALs, removes ONLY the final COMMIT line, then appends this file from the line that STARTS (column 0) with
-- the DO keyword onward; the code asserts no COMMIT and no bare END; and that it ends by raising. (The 0130 lesson.)
-- The DO body has no bare end statement: nested blocks are labelled and the block closes with the labelled dollar tag.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so every write is undone.
-- PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send the transaction-abort statement.
--
-- It never inserts or deletes public.users rows (prod users rows are tied to auth.users). Data-dependent checks use EXISTING
-- rows and are skipped when the data is absent: find_account (a sig shared by 2+ users, a sig held by exactly 1), and the three
-- revoke triggers (a user present in both public.users and auth.users). Pure checks always run.

DO $selftest$
DECLARE
  v_sig2   text;
  v_sig1   text;
  v_r      record;
  v_u      uuid;
  v_n      int;
  v_ev     int;
  v_hash   text := 'selftest-' || gen_random_uuid()::text;
  v_plan   text := '';
  v_line   text;
  v_i      int;
  v_res    boolean;
BEGIN
  -- ghana_phone_sig
  IF public.ghana_phone_sig('0241234567') IS DISTINCT FROM '241234567' THEN RAISE EXCEPTION 'FAIL sig_local'; END IF;
  IF public.ghana_phone_sig('+233 24 123 4567') IS DISTINCT FROM '241234567' THEN RAISE EXCEPTION 'FAIL sig_plus233'; END IF;
  IF public.ghana_phone_sig('233241234567') IS DISTINCT FROM '241234567' THEN RAISE EXCEPTION 'FAIL sig_233'; END IF;
  IF public.ghana_phone_sig('12345') IS NOT NULL THEN RAISE EXCEPTION 'FAIL sig_short'; END IF;
  IF public.ghana_phone_sig('0141234567') IS NOT NULL THEN RAISE EXCEPTION 'FAIL sig_bad_prefix'; END IF;
  IF public.ghana_phone_sig(NULL) IS NOT NULL THEN RAISE EXCEPTION 'FAIL sig_null'; END IF;

  -- find_account on existing data
  SELECT public.ghana_phone_sig(phone_number) INTO v_sig2 FROM public.users
   WHERE public.ghana_phone_sig(phone_number) IS NOT NULL
   GROUP BY 1 HAVING count(*) > 1 ORDER BY 1 LIMIT 1;
  IF v_sig2 IS NOT NULL THEN
    SELECT * INTO v_r FROM public.phone_login_find_account(v_sig2);
    IF v_r.match_count < 2 THEN RAISE EXCEPTION 'FAIL find_dup_count %', v_r.match_count; END IF;
    IF v_r.user_id IS NOT NULL OR v_r.email IS NOT NULL OR v_r.phone_number IS NOT NULL
       OR v_r.phone_verified IS NOT NULL OR v_r.is_suspended IS NOT NULL THEN RAISE EXCEPTION 'FAIL find_dup_leaks'; END IF;
  END IF;

  SELECT public.ghana_phone_sig(phone_number) INTO v_sig1 FROM public.users
   WHERE public.ghana_phone_sig(phone_number) IS NOT NULL
   GROUP BY 1 HAVING count(*) = 1 ORDER BY 1 LIMIT 1;
  IF v_sig1 IS NOT NULL THEN
    SELECT * INTO v_r FROM public.phone_login_find_account(v_sig1);
    IF v_r.match_count <> 1 OR v_r.user_id IS NULL THEN RAISE EXCEPTION 'FAIL find_unique'; END IF;
  END IF;

  SELECT count(*) INTO v_n FROM public.phone_login_find_account('999999999');
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL find_none_rows %', v_n; END IF;
  IF (SELECT match_count FROM public.phone_login_find_account('999999999')) <> 0 THEN RAISE EXCEPTION 'FAIL find_none_count'; END IF;

  -- lockout
  FOR v_i IN 1..4 LOOP
    v_res := public.phone_login_record_failure(v_hash, 'selftest-ip');
    IF v_res THEN RAISE EXCEPTION 'FAIL locked_too_early %', v_i; END IF;
  END LOOP;
  IF public.phone_login_is_locked(v_hash) THEN RAISE EXCEPTION 'FAIL is_locked_early'; END IF;
  IF NOT public.phone_login_record_failure(v_hash, 'selftest-ip') THEN RAISE EXCEPTION 'FAIL not_locked_at_5'; END IF;
  IF NOT public.phone_login_is_locked(v_hash) THEN RAISE EXCEPTION 'FAIL is_locked_false'; END IF;
  SELECT count(*) INTO v_n FROM public.phone_login_events WHERE kind = 'lockout' AND phone_hash = v_hash;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL lockout_rows %', v_n; END IF;
  PERFORM public.phone_login_record_failure(v_hash, 'selftest-ip');
  SELECT count(*) INTO v_n FROM public.phone_login_events WHERE kind = 'lockout' AND phone_hash = v_hash;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL lockout_rows_after_6 %', v_n; END IF;

  -- revoke triggers, on an existing user present in both tables
  SELECT u.id INTO v_u FROM public.users u JOIN auth.users a ON a.id = u.id ORDER BY u.id LIMIT 1;
  IF v_u IS NOT NULL THEN
    -- password
    INSERT INTO public.trusted_devices(user_id, token_hash, expires_at) VALUES (v_u, 'selftest-pw', now() + interval '1 day');
    SELECT count(*) INTO v_ev FROM public.phone_login_events WHERE kind = 'password_changed' AND user_id = v_u;
    UPDATE auth.users SET encrypted_password = coalesce(encrypted_password, '') || 'x' WHERE id = v_u;
    IF (SELECT revoked_at FROM public.trusted_devices WHERE token_hash = 'selftest-pw') IS NULL THEN RAISE EXCEPTION 'FAIL pw_not_revoked'; END IF;
    SELECT count(*) INTO v_n FROM public.phone_login_events WHERE kind = 'password_changed' AND user_id = v_u;
    IF v_n <> v_ev + 1 THEN RAISE EXCEPTION 'FAIL pw_event %', v_n; END IF;

    -- ban
    INSERT INTO public.trusted_devices(user_id, token_hash, expires_at) VALUES (v_u, 'selftest-ban', now() + interval '1 day');
    UPDATE auth.users SET banned_until = now() + interval '1 hour' WHERE id = v_u;
    IF (SELECT revoked_at FROM public.trusted_devices WHERE token_hash = 'selftest-ban') IS NULL THEN RAISE EXCEPTION 'FAIL ban_not_revoked'; END IF;

    -- phone change
    INSERT INTO public.trusted_devices(user_id, token_hash, expires_at) VALUES (v_u, 'selftest-phone', now() + interval '1 day');
    UPDATE public.users SET phone_number = coalesce(phone_number, '') || ' ' WHERE id = v_u;
    IF (SELECT revoked_at FROM public.trusted_devices WHERE token_hash = 'selftest-phone') IS NULL THEN RAISE EXCEPTION 'FAIL phone_not_revoked'; END IF;

    -- suspension
    UPDATE public.users SET is_suspended = false WHERE id = v_u;
    INSERT INTO public.trusted_devices(user_id, token_hash, expires_at) VALUES (v_u, 'selftest-susp', now() + interval '1 day');
    UPDATE public.users SET is_suspended = true WHERE id = v_u;
    IF (SELECT revoked_at FROM public.trusted_devices WHERE token_hash = 'selftest-susp') IS NULL THEN RAISE EXCEPTION 'FAIL susp_not_revoked'; END IF;
  END IF;

  -- RLS + privileges
  IF (SELECT count(*) FROM pg_class WHERE oid IN ('public.phone_login_events'::regclass, 'public.phone_login_challenges'::regclass, 'public.trusted_devices'::regclass) AND relrowsecurity) <> 3 THEN
    RAISE EXCEPTION 'FAIL rls_not_enabled';
  END IF;
  FOREACH v_line IN ARRAY ARRAY['public.phone_login_events', 'public.phone_login_challenges', 'public.trusted_devices'] LOOP
    IF has_table_privilege('anon', v_line, 'select') OR has_table_privilege('authenticated', v_line, 'select') THEN
      RAISE EXCEPTION 'FAIL table_readable_by_client %', v_line;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.phone_login_find_account(text)', 'execute')
     OR has_function_privilege('authenticated', 'public.phone_login_find_account(text)', 'execute') THEN
    RAISE EXCEPTION 'FAIL find_account_executable_by_client';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.phone_login_find_account(text)', 'execute') THEN RAISE EXCEPTION 'FAIL service_role_cannot_execute'; END IF;

  -- the expression index serves the lookup
  SET LOCAL enable_seqscan = off;
  FOR v_line IN EXECUTE $q$EXPLAIN SELECT id FROM public.users WHERE public.ghana_phone_sig(phone_number) = '241234567'$q$ LOOP
    v_plan := v_plan || v_line || E'\n';
  END LOOP;
  IF position('users_phone_sig_idx' IN v_plan) = 0 THEN RAISE EXCEPTION 'FAIL index_not_used: %', v_plan; END IF;

  -- settings
  IF (SELECT count(*) FROM public.admin_settings WHERE key IN ('phone_login_enabled', 'phone_login_new_device_code')) <> 2 THEN
    RAISE EXCEPTION 'FAIL settings_missing';
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0201 (rolled back)';
END $selftest$;
