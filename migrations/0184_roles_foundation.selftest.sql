-- 0184_roles_foundation.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0184_roles_foundation.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as lib/roles/migration-0184-run.ts does:
--   1. 0184_roles_foundation.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: nested blocks are labelled (`END b_x;`) and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new tables, the backfill and
-- every test write below are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other
-- error means it failed. If the client keeps the session open, send `ROLLBACK;`.
--
-- Checks: seeds, backfill, both mirror directions, non-dealer rows ignored, price > 0, system-role protection, users.role FK,
-- RLS on, zero policies, anon / authenticated hold no privilege.

DO $selftest$
DECLARE
  v_n       int;
  v_n2      int;
  v_rank    int;
  v_pkg     uuid;
  v_uid     uuid;
  v_dealer  uuid;
  v_test    uuid;
  v_price   numeric;
  v_failed  boolean;
  v_rls     boolean;
  v_pol     int;
  v_p       text;
  v_role    text;
  v_tbl     text;
BEGIN
  -- seeds
  SELECT count(*) INTO v_n FROM public.roles WHERE slug IN ('user', 'dealer', 'sub_agent', 'admin') AND is_system;
  IF v_n <> 4 THEN RAISE EXCEPTION 'FAIL seed_roles_count %', v_n; END IF;
  SELECT rank INTO v_rank FROM public.roles WHERE slug = 'user';
  IF v_rank IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL seed_user_rank %', v_rank; END IF;
  SELECT rank INTO v_rank FROM public.roles WHERE slug = 'dealer';
  IF v_rank IS DISTINCT FROM 10 THEN RAISE EXCEPTION 'FAIL seed_dealer_rank %', v_rank; END IF;
  SELECT count(*) INTO v_n FROM public.roles WHERE slug IN ('sub_agent', 'admin') AND rank IS NULL;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL seed_null_ranks %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.roles d JOIN public.roles u ON u.id = d.fallback_role_id
   WHERE d.slug = 'dealer' AND d.is_public AND u.slug = 'user';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL seed_dealer_public_fallback'; END IF;

  SELECT id INTO v_dealer FROM public.roles WHERE slug = 'dealer';

  -- backfill: one dealer row per package with dealer_price > 0
  SELECT count(*) INTO v_n FROM public.packages WHERE dealer_price > 0;
  SELECT count(*) INTO v_n2 FROM public.role_package_prices WHERE role_id = v_dealer;
  IF v_n <> v_n2 THEN RAISE EXCEPTION 'FAIL backfill_dealer_rows packages=% rows=%', v_n, v_n2; END IF;

  SELECT id INTO v_pkg FROM public.packages ORDER BY id LIMIT 1;
  IF v_pkg IS NULL THEN RAISE EXCEPTION 'FAIL no_package_to_test'; END IF;

  -- packages -> role_package_prices
  UPDATE public.packages SET dealer_price = 3.90 WHERE id = v_pkg;
  SELECT count(*), max(price) INTO v_n, v_price FROM public.role_package_prices WHERE role_id = v_dealer AND package_id = v_pkg;
  IF v_n <> 1 OR v_price IS DISTINCT FROM 3.90 THEN RAISE EXCEPTION 'FAIL mirror_pkg_to_row rows=% price=%', v_n, v_price; END IF;
  SELECT dealer_price INTO v_price FROM public.packages WHERE id = v_pkg;
  IF v_price IS DISTINCT FROM 3.90 THEN RAISE EXCEPTION 'FAIL mirror_pkg_value_kept %', v_price; END IF;

  UPDATE public.packages SET dealer_price = 0 WHERE id = v_pkg;
  SELECT count(*) INTO v_n FROM public.role_package_prices WHERE role_id = v_dealer AND package_id = v_pkg;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL mirror_pkg_zero_deletes_row %', v_n; END IF;

  UPDATE public.packages SET dealer_price = NULL WHERE id = v_pkg;
  SELECT count(*) INTO v_n FROM public.role_package_prices WHERE role_id = v_dealer AND package_id = v_pkg;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL mirror_pkg_null_stays_gone %', v_n; END IF;

  -- role_package_prices -> packages
  INSERT INTO public.role_package_prices (role_id, package_id, price) VALUES (v_dealer, v_pkg, 2.25);
  SELECT dealer_price INTO v_price FROM public.packages WHERE id = v_pkg;
  IF v_price IS DISTINCT FROM 2.25 THEN RAISE EXCEPTION 'FAIL mirror_row_insert_to_pkg %', v_price; END IF;
  SELECT count(*) INTO v_n FROM public.role_package_prices WHERE role_id = v_dealer AND package_id = v_pkg;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL mirror_row_insert_exactly_one %', v_n; END IF;

  UPDATE public.role_package_prices SET price = 2.75 WHERE role_id = v_dealer AND package_id = v_pkg;
  SELECT dealer_price INTO v_price FROM public.packages WHERE id = v_pkg;
  IF v_price IS DISTINCT FROM 2.75 THEN RAISE EXCEPTION 'FAIL mirror_row_update_to_pkg %', v_price; END IF;

  DELETE FROM public.role_package_prices WHERE role_id = v_dealer AND package_id = v_pkg;
  SELECT dealer_price INTO v_price FROM public.packages WHERE id = v_pkg;
  IF v_price IS NOT NULL THEN RAISE EXCEPTION 'FAIL mirror_row_delete_nulls_pkg %', v_price; END IF;
  SELECT count(*) INTO v_n FROM public.role_package_prices WHERE role_id = v_dealer AND package_id = v_pkg;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL mirror_row_delete_stays_gone %', v_n; END IF;

  -- a non-dealer role's price row leaves packages.dealer_price untouched
  UPDATE public.packages SET dealer_price = 1.11 WHERE id = v_pkg;
  INSERT INTO public.roles (slug, name) VALUES ('selftest_role', 'Selftest') RETURNING id INTO v_test;
  INSERT INTO public.role_package_prices (role_id, package_id, price) VALUES (v_test, v_pkg, 9.99);
  SELECT dealer_price INTO v_price FROM public.packages WHERE id = v_pkg;
  IF v_price IS DISTINCT FROM 1.11 THEN RAISE EXCEPTION 'FAIL nondealer_insert_touched_pkg %', v_price; END IF;
  UPDATE public.role_package_prices SET price = 8.88 WHERE role_id = v_test AND package_id = v_pkg;
  DELETE FROM public.role_package_prices WHERE role_id = v_test AND package_id = v_pkg;
  SELECT dealer_price INTO v_price FROM public.packages WHERE id = v_pkg;
  IF v_price IS DISTINCT FROM 1.11 THEN RAISE EXCEPTION 'FAIL nondealer_change_touched_pkg %', v_price; END IF;
  SELECT count(*) INTO v_n FROM public.role_package_prices WHERE role_id = v_dealer AND package_id = v_pkg AND price = 1.11;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL nondealer_dealer_row_disturbed %', v_n; END IF;

  -- price = 0 refused by the check constraint
  v_failed := false;
  <<b_price0>>
  BEGIN
    INSERT INTO public.role_package_prices (role_id, package_id, price) VALUES (v_test, v_pkg, 0);
  EXCEPTION WHEN check_violation THEN
    v_failed := true;
  END b_price0;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL price_zero_allowed'; END IF;

  -- system-role protection
  v_failed := false;
  <<b_del>>
  BEGIN
    DELETE FROM public.roles WHERE slug = 'dealer';
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END b_del;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL system_role_deleted'; END IF;

  v_failed := false;
  <<b_slug>>
  BEGIN
    UPDATE public.roles SET slug = 'x' WHERE slug = 'user';
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END b_slug;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL system_slug_changed'; END IF;

  v_failed := false;
  <<b_sys>>
  BEGIN
    UPDATE public.roles SET is_system = false WHERE slug = 'admin';
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END b_sys;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL system_flag_changed'; END IF;

  v_failed := false;
  <<b_arch>>
  BEGIN
    UPDATE public.roles SET archived_at = now() WHERE slug = 'sub_agent';
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END b_arch;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL system_role_archived'; END IF;

  -- a custom role can be deleted
  DELETE FROM public.roles WHERE slug = 'selftest_role';
  SELECT count(*) INTO v_n FROM public.roles WHERE slug = 'selftest_role';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL custom_role_not_deletable'; END IF;

  -- users.role FK
  SELECT id INTO v_uid FROM public.users WHERE role IS NOT NULL LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'FAIL no_user_to_test'; END IF;
  v_failed := false;
  <<b_fk>>
  BEGIN
    UPDATE public.users SET role = 'nope' WHERE id = v_uid;
  EXCEPTION WHEN foreign_key_violation THEN
    v_failed := true;
  END b_fk;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL users_role_fk_missing'; END IF;

  -- RLS on both tables, zero policies, anon / authenticated hold no privilege
  FOREACH v_tbl IN ARRAY ARRAY['roles', 'role_package_prices'] LOOP
    SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = ('public.' || v_tbl)::regclass;
    IF v_rls IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL rls_not_enabled %', v_tbl; END IF;

    SELECT count(*) INTO v_pol FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl;
    IF v_pol <> 0 THEN RAISE EXCEPTION 'FAIL policies_present % %', v_tbl, v_pol; END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(v_role, 'public.' || v_tbl, v_p) THEN
          RAISE EXCEPTION 'FAIL % has % on %', v_role, v_p, v_tbl;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  RAISE EXCEPTION 'SELFTEST_OK 0184 (rolled back)';
END $selftest$;
