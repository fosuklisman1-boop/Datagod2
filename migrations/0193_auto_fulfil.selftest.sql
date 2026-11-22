-- 0193_auto_fulfil.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0193_auto_fulfil.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it with lib/auto-fulfil/migration-0193-run.ts (as lib/auto-fulfil/migration-0193.test.ts does):
--   1. 0193_auto_fulfil.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the column, the tables, the functions
-- and EVERY test row are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send `ROLLBACK;`.
--
-- User: NO users row is created (prod public.users.id references auth.users(id)). Like the 0132/0141/0159/0160 selftests, it borrows an
-- existing user: the first public.users row joined to auth.users (ORDER BY id), and raises 'FAIL setup: ...' if there is none. Nothing
-- on that user is changed; it only owns the two seeded orders, which roll back.
--
-- PRE-CHECK before the dry run (read-only): orders columns that are NOT NULL without a default. The seed INSERT supplies
-- id, user_id, network, size, price, status, phone_number, created_at; any other column listed here must be added to it first.
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'orders' AND is_nullable = 'NO' AND column_default IS NULL
--    ORDER BY ordinal_position;
--
-- Seed rows: orders rows (prod: orders.user_id NOT NULL, FK users) with phone_number '0000000000' (a dummy, not a real
-- customer), fulfillment_queue rows (batch_id NOT NULL uuid, order_type in shop/bulk/api/ussd/ussd_shop) with order ids
-- 'selftest-0193-*'. Scenarios (labels): source, candidates, quiet, claim, grants.
-- NOTE: the claim scenario first parks every pending queue row as 'failed' INSIDE the transaction (rolled back with everything else),
-- so on prod the claim only ever sees the seeded rows and no real pending row is claimed or kept.

DO $selftest$
DECLARE
  v_user uuid;
  v_old  uuid := gen_random_uuid();
  v_new  uuid := gen_random_uuid();
  v_n    int;
  v_a    int;
  v_m    int;
BEGIN
  SELECT u.id INTO v_user
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  ORDER BY u.id
  LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'FAIL setup: no users row joined to auth.users to own the seeded orders';
  END IF;

  INSERT INTO orders (id, user_id, network, size, price, status, phone_number, created_at) VALUES
    (v_old, v_user, 'MTN', '1', 5, 'pending', '0000000000', now() - interval '11 minutes'),
    (v_new, v_user, 'MTN', '1', 5, 'pending', '0000000000', now() - interval '9 minutes');

  -- source: default 'admin', other values refused -----------------------------------------------------------
  INSERT INTO fulfillment_queue (batch_id, order_id, order_type) VALUES (gen_random_uuid(), 'selftest-0193-d', 'bulk');
  IF (SELECT source FROM fulfillment_queue WHERE order_id = 'selftest-0193-d') <> 'admin' THEN
    RAISE EXCEPTION 'FAIL source: default is not admin';
  END IF;
  EXECUTE $inner$
    DO $x$ BEGIN
      INSERT INTO fulfillment_queue (batch_id, order_id, order_type, source) VALUES (gen_random_uuid(), 'selftest-0193-x', 'bulk', 'other');
      RAISE EXCEPTION 'FAIL source: source other was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END $x$;
  $inner$;

  -- candidates: 11 min old is returned, 9 min old is not -------------------------------------------------------
  SELECT count(*) INTO v_n FROM auto_fulfil_candidates(10, 7, ARRAY['MTN'], 100) c WHERE c.id = v_old::text;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL candidates: 11 min old order not returned'; END IF;
  SELECT count(*) INTO v_n FROM auto_fulfil_candidates(10, 7, ARRAY['MTN'], 100) c WHERE c.id = v_new::text;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL candidates: 9 min old order returned'; END IF;
  SELECT count(*) INTO v_n FROM auto_fulfil_candidates(10, 7, ARRAY['Telecel'], 100) c WHERE c.id = v_old::text;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL candidates: network filter ignored'; END IF;

  -- quiet: recent queue activity hides the order, old activity does not -------------------------------------------
  INSERT INTO fulfillment_queue (batch_id, order_id, order_type, status, completed_at)
    VALUES (gen_random_uuid(), v_old::text, 'bulk', 'completed', now() - interval '5 minutes');
  SELECT count(*) INTO v_n FROM auto_fulfil_candidates(10, 7, ARRAY['MTN'], 100) c WHERE c.id = v_old::text;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL quiet: recent queue completion did not hide the order'; END IF;
  UPDATE fulfillment_queue SET enqueued_at = now() - interval '30 minutes', completed_at = now() - interval '15 minutes'
    WHERE order_id = v_old::text;
  SELECT count(*) INTO v_n FROM auto_fulfil_candidates(10, 7, ARRAY['MTN'], 100) c WHERE c.id = v_old::text;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL quiet: old queue completion still hides the order'; END IF;

  -- claim: 10 auto + 10 admin, limit 20 / auto 5 => at least those 5 auto + the admin rows, processing, attempt_count 1 ----------
  UPDATE fulfillment_queue SET status = 'failed' WHERE status = 'pending';   -- park any live rows (rolled back); only our seeds stay pending
  INSERT INTO fulfillment_queue (batch_id, order_id, order_type, source, enqueued_at)
    SELECT gen_random_uuid(), 'selftest-0193-auto-' || g, 'bulk', 'auto', now() - make_interval(secs => 100 - g) FROM generate_series(1, 10) g;
  INSERT INTO fulfillment_queue (batch_id, order_id, order_type, source, enqueued_at)
    SELECT gen_random_uuid(), 'selftest-0193-adm-' || g, 'bulk', 'admin', now() - make_interval(secs => 100 - g) FROM generate_series(1, 10) g;
  SELECT count(*) FILTER (WHERE source = 'auto'), count(*) FILTER (WHERE source = 'admin')
    INTO v_a, v_m FROM claim_fulfillment_queue_split(20, 5);
  IF v_a <> 5 OR v_m <> 10 THEN RAISE EXCEPTION 'FAIL claim: got % auto and % admin, want 5 and 10', v_a, v_m; END IF;
  SELECT count(*) INTO v_n FROM fulfillment_queue
   WHERE order_id LIKE 'selftest-0193-%' AND status = 'processing' AND attempt_count = 1 AND last_attempted_at IS NOT NULL;
  IF v_n <> 15 THEN RAISE EXCEPTION 'FAIL claim: % rows processing with attempt_count 1, want 15', v_n; END IF;

  -- grants: closed to anon/authenticated, open to service_role --------------------------------------------------------
  IF has_table_privilege('anon', 'public.auto_fulfil_runs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.auto_fulfil_attempts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.auto_fulfil_settings_log', 'INSERT')
     OR has_function_privilege('anon', 'public.auto_fulfil_candidates(int,int,text[],int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.auto_fulfil_candidates(int,int,text[],int)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.claim_fulfillment_queue_split(int,int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_fulfillment_queue_split(int,int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL grants: anon/authenticated can reach the auto-fulfil objects';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.auto_fulfil_runs', 'INSERT')
     OR NOT has_function_privilege('service_role', 'public.auto_fulfil_candidates(int,int,text[],int)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.claim_fulfillment_queue_split(int,int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL grants: service_role lacks rights';
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0193 source default, candidate age gate and quiet window, split claim caps auto rows, objects locked down';
END $selftest$;
