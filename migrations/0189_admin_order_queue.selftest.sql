-- 0189_admin_order_queue.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0189_admin_order_queue.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as lib/order-queue/migration-0189.test.ts does (lib/order-queue/migration-0189-run.ts):
--   1. 0189_admin_order_queue.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so both functions and EVERY test row
-- are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send `ROLLBACK;`.
--
-- The seeded orders use the unique phone prefix 059918900 and every call filters by that search, so real rows never count.
-- Seed rows go into `orders` (bulk) with only the columns below; if prod has an extra NOT NULL column the dry run fails
-- loudly (nothing is left behind). Scenarios (labels): catalog, grants, views, counts, reasons.

DO $selftest$
DECLARE
  v_n      int;
  v_id1    uuid := gen_random_uuid();
  v_id2    uuid := gen_random_uuid();
  v_id3    uuid := gen_random_uuid();
  v_id4    uuid := gen_random_uuid();
  v_id5    uuid := gen_random_uuid();
  v_id6    uuid := gen_random_uuid();
  v_f      text;
  v_role   text;
  v_c      jsonb;
  v_uid    uuid;
BEGIN
  -- catalog: both functions exist with the agreed result shape ---------------------------------------
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('admin_order_queue', 'admin_order_queue_counts');
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL catalog: expected 2 functions, found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid = to_regprocedure('public.admin_order_queue(text,text[],text[],text[],timestamptz,timestamptz,text,text,text,int,int)')
     AND pronargs = 11 AND array_length(proallargtypes, 1) = 32 AND prosecdef = false;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: admin_order_queue has the wrong signature or is SECURITY DEFINER'; END IF;

  -- grants: nobody but service_role may execute either function --------------------------------------
  FOREACH v_f IN ARRAY ARRAY[
    'public.admin_order_queue(text,text[],text[],text[],timestamptz,timestamptz,text,text,text,int,int)',
    'public.admin_order_queue_counts(text[],text[],timestamptz,timestamptz,text,text,text)'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_f, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL grants: % can execute %', v_role, v_f; END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', v_f, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL grants: service_role cannot execute %', v_f; END IF;
  END LOOP;

  -- seed: six orders (one per queue case) and their attempts ------------------------------------------
  -- orders.user_id is NOT NULL with a FK to users(id) on prod: borrow any existing user (the rows are rolled back anyway).
  SELECT u.id INTO v_uid FROM public.users u ORDER BY u.created_at LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'FAIL seed: public.users is empty, cannot seed orders (orders.user_id is NOT NULL)'; END IF;
  INSERT INTO public.orders (id, user_id, network, size, price, status, phone_number, order_code, created_at) VALUES
    (v_id1, v_uid, 'mtn', '1', 5, 'pending',    '0599189001', 'ST189-1', now() - interval '1 hour'),
    (v_id2, v_uid, 'mtn', '1', 5, 'reversed',   '0599189002', 'ST189-2', now() - interval '1 hour'),
    (v_id3, v_uid, 'mtn', '1', 5, 'processing', '0599189003', 'ST189-3', now() - interval '1 hour'),
    (v_id4, v_uid, 'mtn', '1', 5, 'processing', '0599189004', 'ST189-4', now() - interval '1 hour'),
    (v_id5, v_uid, 'mtn', '1', 5, 'failed',     '0599189005', 'ST189-5', now() - interval '1 hour'),
    (v_id6, v_uid, 'mtn', '1', 5, 'completed',  '0599189006', 'ST189-6', now() - interval '1 hour');
  INSERT INTO public.mtn_fulfillment_tracking (order_id, status, external_message, created_at) VALUES
    (v_id3::text, 'abandoned',  'no response',                  now() - interval '30 minutes'),
    (v_id4::text, 'processing', 'sent',                         now() - interval '3 hours'),
    (v_id5::text, 'failed',     'Insufficient balance for 2GB', now() - interval '30 minutes');

  -- views: each view returns exactly the expected seeded rows ------------------------------------------
  SELECT count(*) INTO v_n FROM public.admin_order_queue('needs_action', NULL, NULL, NULL, NULL, NULL, '059918900', NULL, NULL, 200, 0)
   WHERE id IN (v_id1::text, v_id2::text);
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL views: needs_action should hold the pending and the reversed order, got %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.admin_order_queue('needs_action', NULL, NULL, NULL, NULL, NULL, '059918900', NULL, NULL, 200, 0);
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL views: needs_action returned % rows, want 2', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.admin_order_queue('held', NULL, NULL, NULL, NULL, NULL, '059918900', NULL, NULL, 200, 0)
   WHERE id = v_id3::text AND is_held AND failure_reason = 'outcome_unknown';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL views: held should hold the abandoned order'; END IF;
  SELECT count(*) INTO v_n FROM public.admin_order_queue('held', NULL, NULL, NULL, NULL, NULL, '059918900', NULL, NULL, 200, 0);
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL views: held returned % rows, want 1', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.admin_order_queue('stuck', NULL, NULL, NULL, NULL, NULL, '059918900', NULL, NULL, 200, 0)
   WHERE id = v_id4::text AND last_attempt_status = 'processing' AND NOT is_held;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL views: stuck should hold the 3-hour-old processing order'; END IF;
  SELECT count(*) INTO v_n FROM public.admin_order_queue('stuck', NULL, NULL, NULL, NULL, NULL, '059918900', NULL, NULL, 200, 0);
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL views: stuck returned % rows, want 1', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.admin_order_queue('failed', NULL, NULL, NULL, NULL, NULL, '059918900', NULL, NULL, 200, 0)
   WHERE id = v_id5::text AND failure_reason = 'out_of_balance' AND last_error = 'Insufficient balance for 2GB' AND attempt_count = 1;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL views: failed should hold the failed order classified out_of_balance'; END IF;

  SELECT count(*) INTO v_n FROM public.admin_order_queue('all', NULL, NULL, NULL, NULL, NULL, '059918900', NULL, NULL, 200, 0);
  IF v_n <> 6 THEN RAISE EXCEPTION 'FAIL views: all returned % rows, want 6', v_n; END IF;

  -- counts: equal the list totals under the same filters ---------------------------------------------
  SELECT jsonb_object_agg(view, n) INTO v_c FROM public.admin_order_queue_counts(NULL, NULL, NULL, NULL, '059918900', NULL, NULL);
  IF v_c IS DISTINCT FROM '{"needs_action":2,"held":1,"stuck":1,"failed":1,"all":6}'::jsonb THEN
    RAISE EXCEPTION 'FAIL counts: got %', v_c;
  END IF;

  -- reasons: the failure_reason filter narrows the list and the counts alike ----------------------------
  SELECT count(*) INTO v_n FROM public.admin_order_queue('all', NULL, NULL, NULL, NULL, NULL, '059918900', NULL, 'out_of_balance', 200, 0);
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL reasons: out_of_balance filter returned % rows, want 1', v_n; END IF;
  SELECT c.n INTO v_n FROM public.admin_order_queue_counts(NULL, NULL, NULL, NULL, '059918900', NULL, 'outcome_unknown') c WHERE c.view = 'held';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL reasons: outcome_unknown held count is %, want 1', v_n; END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0189 admin_order_queue and counts: shape, grants, views, counts and failure reasons';
END $selftest$;
