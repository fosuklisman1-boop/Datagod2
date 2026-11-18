-- 0186_role_service_rates.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0186_role_service_rates.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and that this DO block has no bare
-- `END;` statement and ends by raising. (The 0130 incident lesson.) Build it as lib/roles/migration-0186-run.ts does:
--   1. 0186_role_service_rates.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: nested blocks are labelled (`END b_x;`) and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new table and every test
-- write below are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it
-- failed. If the client keeps the session open, send `ROLLBACK;`.
--
-- Checks: table exists, RLS on, zero policies, no privilege for anon / authenticated, CHECK rejects 101 / -1 / a bad key,
-- accepts the 0 and 100 bounds, FK cascade on role delete (temp custom role), PK uniqueness.

DO $selftest$
DECLARE
  v_role   uuid;
  v_role2  uuid;
  v_n      int;
  v_who    text;
BEGIN
  IF to_regclass('public.role_service_rates') IS NULL THEN RAISE EXCEPTION 'FAIL table_missing'; END IF;
  IF NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.role_service_rates'::regclass), false) THEN
    RAISE EXCEPTION 'FAIL rls_not_enabled';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'role_service_rates';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL has_policies %', v_n; END IF;

  FOREACH v_who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_who, 'public.role_service_rates', 'SELECT')
       OR has_table_privilege(v_who, 'public.role_service_rates', 'INSERT')
       OR has_table_privilege(v_who, 'public.role_service_rates', 'UPDATE')
       OR has_table_privilege(v_who, 'public.role_service_rates', 'DELETE') THEN
      RAISE EXCEPTION 'FAIL client_role_has_privilege %', v_who;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.role_service_rates', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.role_service_rates', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL service_role_lacks_privilege';
  END IF;

  INSERT INTO public.roles (slug, name, rank) VALUES ('selftest_rates', 'Selftest rates', NULL) RETURNING id INTO v_role;
  INSERT INTO public.roles (slug, name, rank) VALUES ('selftest_rates2', 'Selftest rates 2', NULL) RETURNING id INTO v_role2;

  -- bounds are accepted
  INSERT INTO public.role_service_rates (role_id, service_key, value) VALUES (v_role, 'airtime_fee:mtn', 0);
  INSERT INTO public.role_service_rates (role_id, service_key, value) VALUES (v_role, 'cashback_share:bundles', 100);

  -- CHECK: value above 100
  <<b_101>>
  BEGIN
    INSERT INTO public.role_service_rates (role_id, service_key, value) VALUES (v_role, 'airtime_fee:at', 101);
    RAISE EXCEPTION 'FAIL value_101_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END b_101;

  -- CHECK: negative value
  <<b_neg>>
  BEGIN
    INSERT INTO public.role_service_rates (role_id, service_key, value) VALUES (v_role, 'airtime_fee:at', -1);
    RAISE EXCEPTION 'FAIL value_negative_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END b_neg;

  -- CHECK: bad service key
  <<b_key>>
  BEGIN
    INSERT INTO public.role_service_rates (role_id, service_key, value) VALUES (v_role, 'Bad Key', 5);
    RAISE EXCEPTION 'FAIL bad_key_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END b_key;

  -- PK: the same (role, key) twice
  <<b_pk>>
  BEGIN
    INSERT INTO public.role_service_rates (role_id, service_key, value) VALUES (v_role, 'airtime_fee:mtn', 2);
    RAISE EXCEPTION 'FAIL duplicate_pk_accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END b_pk;

  -- the same key under another role is fine
  INSERT INTO public.role_service_rates (role_id, service_key, value) VALUES (v_role2, 'airtime_fee:mtn', 2);

  -- FK: an unknown role is refused
  <<b_fk>>
  BEGIN
    INSERT INTO public.role_service_rates (role_id, service_key, value) VALUES (gen_random_uuid(), 'airtime_fee:mtn', 1);
    RAISE EXCEPTION 'FAIL unknown_role_accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END b_fk;

  -- cascade: deleting the role removes only its rows
  DELETE FROM public.roles WHERE id = v_role;
  SELECT count(*) INTO v_n FROM public.role_service_rates WHERE role_id = v_role;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL cascade_left_rows %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.role_service_rates WHERE role_id = v_role2;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL cascade_removed_other_roles_rows %', v_n; END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0186 (rolled back)';
END $selftest$;
