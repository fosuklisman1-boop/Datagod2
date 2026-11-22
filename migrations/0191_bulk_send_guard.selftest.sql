-- 0191_bulk_send_guard.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0191_bulk_send_guard.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it with lib/order-queue/migration-0191-run.ts (as lib/order-queue/migration-0191.test.ts does):
--   1. 0191_bulk_send_guard.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the index, the table and EVERY test
-- row are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send `ROLLBACK;`.
--
-- Seed rows go only into fulfillment_queue (prod constraints: batch_id NOT NULL uuid, order_id NOT NULL text, order_type in
-- shop/bulk/api/ussd/ussd_shop, status in pending/processing/completed/failed) with order ids 'selftest-0191-*', and into
-- admin_bulk_send_log (admin_id is a plain uuid, no FK). Scenarios (labels): index, dupes, conflict, history, log.

DO $selftest$
DECLARE
  v_n int;
BEGIN
  -- index: exists and is unique + partial --------------------------------------------------------------
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE tablename = 'fulfillment_queue' AND indexname = 'fulfillment_queue_one_live_per_order'
     AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%pending%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL index: unique partial index missing'; END IF;

  -- dupes: a second live row for the same order is refused -----------------------------------------------
  INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status) VALUES (gen_random_uuid(), 'selftest-0191-a', 'bulk', 'pending');
  -- (inner block runs via EXECUTE so this file never contains a bare END; statement)
  EXECUTE $inner$
    DO $x$ BEGIN
      INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status) VALUES (gen_random_uuid(), 'selftest-0191-a', 'bulk', 'processing');
      RAISE EXCEPTION 'FAIL dupes: second live row was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END $x$;
  $inner$;

  -- conflict: ON CONFLICT DO NOTHING inserts nothing -----------------------------------------------------
  INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status) VALUES (gen_random_uuid(), 'selftest-0191-a', 'bulk', 'pending')
    ON CONFLICT (order_id) WHERE status IN ('pending', 'processing') DO NOTHING;
  SELECT count(*) INTO v_n FROM fulfillment_queue WHERE order_id = 'selftest-0191-a';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL conflict: % rows for the order, want 1', v_n; END IF;

  -- history: completed + failed rows beside a pending one are allowed -------------------------------------
  INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status) VALUES (gen_random_uuid(), 'selftest-0191-b', 'bulk', 'completed');
  INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status) VALUES (gen_random_uuid(), 'selftest-0191-b', 'bulk', 'failed');
  INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status) VALUES (gen_random_uuid(), 'selftest-0191-b', 'bulk', 'pending');

  -- log: table accepts a row and is closed to anon/authenticated -----------------------------------------
  INSERT INTO admin_bulk_send_log (admin_id, supplier, accepted_ids) VALUES (gen_random_uuid(), 'selftest', ARRAY['selftest-0191-a']);
  IF has_table_privilege('anon', 'public.admin_bulk_send_log', 'SELECT')
     OR has_table_privilege('authenticated', 'public.admin_bulk_send_log', 'SELECT')
     OR has_table_privilege('authenticated', 'public.admin_bulk_send_log', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL log: anon/authenticated can reach admin_bulk_send_log';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.admin_bulk_send_log', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL log: service_role cannot insert';
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0191 one live queue row per order, history allowed, conflict no-op, send log locked down';
END $selftest$;
