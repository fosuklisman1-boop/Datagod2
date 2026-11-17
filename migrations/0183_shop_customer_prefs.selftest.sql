-- 0183_shop_customer_prefs.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0183_shop_customer_prefs.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as lib/shop-commerce/migration-0183.test.ts does:
--   1. 0183_shop_customer_prefs.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new table and the backfilled
-- rows are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send `ROLLBACK;`.
--
-- Checks: RLS on, zero policies, anon / authenticated hold no privilege.

DO $selftest$
DECLARE
  v_rls  boolean;
  v_pol  int;
  v_p    text;
  v_role text;
BEGIN
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.shop_customer_prefs'::regclass;
  IF v_rls IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL rls_not_enabled'; END IF;

  SELECT count(*) INTO v_pol FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shop_customer_prefs';
  IF v_pol <> 0 THEN RAISE EXCEPTION 'FAIL policies_present %', v_pol; END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.shop_customer_prefs', v_p) THEN
        RAISE EXCEPTION 'FAIL % has % on shop_customer_prefs', v_role, v_p;
      END IF;
    END LOOP;
  END LOOP;

  RAISE EXCEPTION 'SELFTEST_OK 0183 (rolled back)';
END $selftest$;
