-- 0194_strict_supplier_verification.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0194_strict_supplier_verification.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it with lib/strict-verify/migration-0194-run.ts (as lib/strict-verify/migration-0194.test.ts does):
--   1. 0194_strict_supplier_verification.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the tables and EVERY test row are rolled
-- back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send `ROLLBACK;`.
--
-- Seed rows: only mtn_supplier_verdicts and mtn_strict_holds rows, with the dummy phone '0000000000' and ids 'selftest-0194-*'.
-- No order rows and no users are touched. Scenarios (labels): verdicts, holds, checks, grants.
DO $selftest$
DECLARE
  v_n int;
BEGIN
  -- verdicts: upsert on (phone, supplier); a bad verdict is rejected.
  INSERT INTO mtn_supplier_verdicts (phone, supplier, verdict) VALUES ('0000000000', 'selftest-0194-a', 'no');
  INSERT INTO mtn_supplier_verdicts (phone, supplier, verdict) VALUES ('0000000000', 'selftest-0194-a', 'yes')
    ON CONFLICT (phone, supplier) DO UPDATE SET verdict = EXCLUDED.verdict, checked_at = now();
  SELECT count(*) INTO v_n FROM mtn_supplier_verdicts WHERE phone = '0000000000' AND supplier = 'selftest-0194-a' AND verdict = 'yes';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL verdicts: upsert did not leave exactly one yes row (%)', v_n;
  END IF;
  <<b_verdict>>
  BEGIN
    INSERT INTO mtn_supplier_verdicts (phone, supplier, verdict) VALUES ('0000000000', 'selftest-0194-b', 'maybe');
    RAISE EXCEPTION 'FAIL verdicts: verdict maybe was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END b_verdict;

  -- holds: defaults, then the CHECKs and the primary key.
  INSERT INTO mtn_strict_holds (order_table, order_id, phone, reason) VALUES ('orders', 'selftest-0194-1', '0000000000', 'rejected');
  SELECT count(*) INTO v_n FROM mtn_strict_holds
   WHERE order_id = 'selftest-0194-1' AND state = 'open' AND sms_sent = false AND held_at IS NOT NULL AND closed_at IS NULL AND last_checked_at IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL holds: defaults are wrong (%)', v_n;
  END IF;
  -- Nested blocks are labelled and closed with END <label>; so the run-string guard against a bare END; stays meaningful.
  <<b_table>>
  BEGIN
    INSERT INTO mtn_strict_holds (order_table, order_id, phone, reason) VALUES ('bogus', 'selftest-0194-2', '0000000000', 'rejected');
    RAISE EXCEPTION 'FAIL checks: order_table bogus was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END b_table;
  <<b_reason>>
  BEGIN
    INSERT INTO mtn_strict_holds (order_table, order_id, phone, reason) VALUES ('orders', 'selftest-0194-3', '0000000000', 'because');
    RAISE EXCEPTION 'FAIL checks: reason because was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END b_reason;
  <<b_state>>
  BEGIN
    INSERT INTO mtn_strict_holds (order_table, order_id, phone, reason, state) VALUES ('orders', 'selftest-0194-4', '0000000000', 'unanswered', 'paused');
    RAISE EXCEPTION 'FAIL checks: state paused was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END b_state;
  <<b_dup>>
  BEGIN
    INSERT INTO mtn_strict_holds (order_table, order_id, phone, reason) VALUES ('orders', 'selftest-0194-1', '0000000000', 'unanswered');
    RAISE EXCEPTION 'FAIL holds: duplicate (order_table, order_id) was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END b_dup;

  -- grants: nothing for anon/authenticated; service_role can write.
  IF has_table_privilege('anon', 'public.mtn_supplier_verdicts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.mtn_supplier_verdicts', 'SELECT')
     OR has_table_privilege('anon', 'public.mtn_strict_holds', 'SELECT')
     OR has_table_privilege('authenticated', 'public.mtn_strict_holds', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL grants: anon/authenticated can reach the strict-verification tables';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.mtn_supplier_verdicts', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.mtn_strict_holds', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL grants: service_role lacks rights';
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0194 verdict upsert and CHECKs, hold defaults and CHECKs, tables locked down';
END $selftest$;
