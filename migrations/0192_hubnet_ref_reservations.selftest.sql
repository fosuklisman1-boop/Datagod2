-- 0192_hubnet_ref_reservations.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0192_hubnet_ref_reservations.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it with lib/hubnet/migration-0192-run.ts (as lib/hubnet/migration-0192.test.ts does):
--   1. 0192_hubnet_ref_reservations.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward.
--   The DO body has no bare `END;`: the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the table and EVERY test
-- row are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send `ROLLBACK;`.
--
-- Seed rows go only into hubnet_ref_reservations with refs 'SELFTEST0192-*'. Scenarios: dupe, kind, blank, privileges.

DO $selftest$
DECLARE
  v_n int;
BEGIN
  -- dupe: the same ref twice is refused ---------------------------------------------------------------
  INSERT INTO hubnet_ref_reservations (ref, kind, order_id) VALUES ('SELFTEST0192-a', 'data', 'selftest-0192-o');
  -- (inner blocks run via EXECUTE so this file never contains a bare END; statement)
  EXECUTE $inner$
    DO $x$ BEGIN
      INSERT INTO hubnet_ref_reservations (ref, kind, order_id) VALUES ('SELFTEST0192-a', 'data', 'selftest-0192-o');
      RAISE EXCEPTION 'FAIL dupe: second reservation of the same ref was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END $x$;
  $inner$;

  -- kind: only data/airtime ---------------------------------------------------------------------------
  EXECUTE $inner$
    DO $x$ BEGIN
      INSERT INTO hubnet_ref_reservations (ref, kind, order_id) VALUES ('SELFTEST0192-b', 'x', 'selftest-0192-o');
      RAISE EXCEPTION 'FAIL kind: kind x was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END $x$;
  $inner$;

  -- blank: an empty or whitespace-only ref is refused (it would collide for every order) -----------------
  EXECUTE $inner$
    DO $x$ BEGIN
      INSERT INTO hubnet_ref_reservations (ref, kind, order_id) VALUES ('', 'data', 'selftest-0192-o');
      RAISE EXCEPTION 'FAIL blank: empty ref was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END $x$;
  $inner$;
  EXECUTE $inner$
    DO $x$ BEGIN
      INSERT INTO hubnet_ref_reservations (ref, kind, order_id) VALUES ('   ', 'data', 'selftest-0192-o');
      RAISE EXCEPTION 'FAIL blank: whitespace-only ref was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END $x$;
  $inner$;

  INSERT INTO hubnet_ref_reservations (ref, kind, order_id) VALUES ('SELFTEST0192-c', 'airtime', 'selftest-0192-o');
  SELECT count(*) INTO v_n FROM hubnet_ref_reservations WHERE ref LIKE 'SELFTEST0192-%';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL kind: % selftest rows, want 2', v_n; END IF;

  -- privileges ----------------------------------------------------------------------------------------
  IF has_table_privilege('anon', 'public.hubnet_ref_reservations', 'SELECT')
     OR has_table_privilege('anon', 'public.hubnet_ref_reservations', 'INSERT')
     OR has_table_privilege('anon', 'public.hubnet_ref_reservations', 'DELETE')
     OR has_table_privilege('authenticated', 'public.hubnet_ref_reservations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.hubnet_ref_reservations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.hubnet_ref_reservations', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL privileges: anon/authenticated can reach hubnet_ref_reservations';
  END IF;
  IF NOT (has_table_privilege('service_role', 'public.hubnet_ref_reservations', 'INSERT')
          AND has_table_privilege('service_role', 'public.hubnet_ref_reservations', 'DELETE')
          AND has_table_privilege('service_role', 'public.hubnet_ref_reservations', 'SELECT')) THEN
    RAISE EXCEPTION 'FAIL privileges: service_role lacks SELECT/INSERT/DELETE';
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0192 one reservation per ref, kind and blank ref checked, table locked down to service_role';
END $selftest$;
