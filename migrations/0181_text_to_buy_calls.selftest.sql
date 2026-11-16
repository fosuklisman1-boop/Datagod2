-- 0181_text_to_buy_calls.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0181_text_to_buy_calls.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as lib/text-to-buy/migration-0181.test.ts does:
--   1. 0181_text_to_buy_calls.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: every sub-block is labelled and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new table, the replaced
-- ttb_purge and EVERY test row are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other
-- error means it failed. If the client keeps the session open, send `ROLLBACK;`.
--
-- It needs 0177 and 0180 applied. Scenarios (labels): catalog, grants, deny_anon / deny_authenticated, check, purge, fn_grants.

DO $selftest$
DECLARE
  v_p      text;
  v_bad    text;
  v_n      int;
  v_ok     boolean;
  v_funcs  CONSTANT text := 'public.ttb_purge(timestamptz)';
BEGIN
  -- catalog: RLS on, no policies, the index exists ---------------------------------------------
  SELECT count(*) INTO v_n FROM pg_class WHERE oid = to_regclass('public.ttb_calls') AND relrowsecurity;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: ttb_calls missing or RLS is off'; END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ttb_calls';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL catalog: ttb_calls has % policies', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ttb_calls' AND indexdef LIKE '%(line, created_at)%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: no (line, created_at) index'; END IF;

  -- grants: nothing for anon or authenticated; service_role SELECT and INSERT only ---------------
  FOREACH v_p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
    IF has_table_privilege('anon', 'public.ttb_calls', v_p) OR has_table_privilege('authenticated', 'public.ttb_calls', v_p) THEN
      RAISE EXCEPTION 'FAIL grants: anon or authenticated has % on ttb_calls', v_p;
    END IF;
    IF v_p IN ('UPDATE', 'DELETE', 'TRUNCATE') AND has_table_privilege('service_role', 'public.ttb_calls', v_p) THEN
      RAISE EXCEPTION 'FAIL grants: service_role has % on ttb_calls', v_p;
    END IF;
    IF v_p IN ('SELECT', 'INSERT') AND NOT has_table_privilege('service_role', 'public.ttb_calls', v_p) THEN
      RAISE EXCEPTION 'FAIL grants: service_role lacks % on ttb_calls', v_p;
    END IF;
  END LOOP;

  -- deny_anon / deny_authenticated: a real read under each role is refused ----------------
  FOREACH v_bad IN ARRAY ARRAY['anon','authenticated'] LOOP
    v_ok := false;
    <<deny>>
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', v_bad);
      EXECUTE 'SELECT count(*) FROM public.ttb_calls' INTO v_n;
    EXCEPTION WHEN insufficient_privilege THEN
      v_ok := true;
    END deny;
    RESET ROLE;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL deny_%: % could read ttb_calls', v_bad, v_bad; END IF;
  END LOOP;

  -- check: every allowed outcome is accepted, a typo and a bad line are refused -------------------
  FOREACH v_p IN ARRAY ARRAY['replied_main','replied_shop','replied_support','skipped_duplicate','skipped_cap',
                             'skipped_off','skipped_invalid','skipped_blocked','skipped_stale','error'] LOOP
    INSERT INTO public.ttb_calls (line, sender, outcome) VALUES ('main', '0200000501', v_p);
  END LOOP;
  v_ok := false;
  <<bad_outcome>>
  BEGIN
    INSERT INTO public.ttb_calls (line, sender, outcome) VALUES ('main', '0200000501', 'replied_typo');
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END bad_outcome;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL check: an unknown outcome was accepted'; END IF;
  v_ok := false;
  <<bad_line>>
  BEGIN
    INSERT INTO public.ttb_calls (line, sender, outcome) VALUES ('other', '0200000501', 'error');
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END bad_line;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL check: an unknown line was accepted'; END IF;

  -- purge: an old call goes, a recent one stays ----------------------------------------------
  INSERT INTO public.ttb_calls (line, sender, outcome, created_at) VALUES ('shop', '0200000502', 'skipped_cap', now() - interval '1 year');
  PERFORM public.ttb_purge(now() - interval '1 day');
  SELECT count(*) INTO v_n FROM public.ttb_calls WHERE sender = '0200000502';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL purge: % old calls survived', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.ttb_calls WHERE sender = '0200000501';
  IF v_n <> 10 THEN RAISE EXCEPTION 'FAIL purge: % recent calls left (want 10)', v_n; END IF;

  -- fn_grants: ttb_purge stays service_role only ---------------------------------------------
  IF has_function_privilege('anon', v_funcs, 'EXECUTE') OR has_function_privilege('authenticated', v_funcs, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL fn_grants: anon or authenticated can execute %', v_funcs;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = v_funcs::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL fn_grants: PUBLIC can execute %', v_funcs; END IF;
  IF NOT has_function_privilege('service_role', v_funcs, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL fn_grants: service_role cannot execute %', v_funcs; END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0181 ttb_calls table, grants and purge';
END $selftest$;
