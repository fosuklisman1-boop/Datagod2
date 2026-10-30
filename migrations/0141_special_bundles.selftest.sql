-- 0141_special_bundles.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0141_special_bundles.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as (lib/standard-bundles/special-migration.test.ts does exactly this and checks it):
--   1. 0141_special_bundles.sql with BEGIN kept (and both SET LOCALs) and ONLY its final
--      transaction-ending line removed; the trailing "Verify after apply" comment lines may stay;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: every sub-block is labelled (`END happy_case;` etc.) and the block
--   closes with `END $selftest$;`. The migration's function body closes with `END` + `$fn$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new columns,
-- constraint, index, function, every wallet deduction, transactions row and child order are rolled back.
-- PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed. If
-- the client keeps the session open afterwards, send `ROLLBACK;`. After the real apply the DO block can
-- also be run alone inside `BEGIN; ...` (never ended with a commit).
--
-- What it cannot cover: true two-session races (two identical calls at once, two keys racing one
-- balance). Those rely on the wallet FOR UPDATE taken before the replay lookup; see the migration header.
-- The same-key replay is covered sequentially (a second call after the first, in the same transaction).
--
-- Scenarios (labels): catalog, grants, deny_anon / deny_authenticated (real call under SET LOCAL ROLE),
-- happy (N=3), replay (same key, and same key with another payload), second_group (new key),
-- no_cashback_group (paid = amount, cashback null), pair_check, short_wallet, bad_total_* (over / under /
-- face / null), n_zero, n_51, n_null, n_mismatch_* (p_n vs row count), paid_not_face_minus_cashback,
-- paid_no_cashback, three_dp_cashback, three_dp_shop_share, negative_shop_share, the other BAD_INPUT
-- shapes, key_used_by_normal_order, bad_key, null_user, final balance.
--
-- Picks the admin (public.users.role = 'admin', joined to auth.users and public.wallets) with the largest
-- wallet balance; it must be >= 3.00 so the happy paths never edit a balance directly. Test phone
-- 233249990141 (unique to this selftest). Amounts: unit face 0.50, pay 0.45, cashback 0.05.
--
-- Types: transactions.reference_id is TEXT; wallets.balance / total_spent and order amounts are numeric;
-- hubtel_data_orders.id and special_group_id are uuid; count(*) (bigint) goes into an int.

DO $selftest$
DECLARE
  v_sig   CONSTANT text := 'public.create_special_bundle_orders(uuid,text,integer,jsonb,numeric)';
  v_phone CONSTANT text := '233249990141';
  v_unit  jsonb;
  v_user  uuid;
  v_bal0  numeric;
  v_spent0 numeric;
  v_bal   numeric;
  v_spent numeric;
  v_key1  text := 'selftest-' || gen_random_uuid()::text;
  v_key2  text := 'selftest-' || gen_random_uuid()::text;
  v_key3  text := 'selftest-' || gen_random_uuid()::text;
  v_key4  text := 'selftest-' || gen_random_uuid()::text;
  v_keyx  text;
  v_pn    int;
  v_res   jsonb;
  v_res2  jsonb;
  v_group uuid;
  v_err   text;
  v_got   text;
  v_role  text;
  v_seen  text;
  v_called boolean;
  v_n     int;
  v_price numeric;
  v_case  text;
  v_rows  jsonb;
  v_total numeric;
  r       record;
BEGIN
  -- Setup -------------------------------------------------------------------
  SELECT u.id, w.balance, COALESCE(w.total_spent, 0) INTO v_user, v_bal0, v_spent0
    FROM public.users u
    JOIN auth.users au ON au.id = u.id
    JOIN public.wallets w ON w.user_id = u.id
   WHERE u.role = 'admin'
   ORDER BY w.balance DESC, u.id
   LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'FAIL setup: no admin with a wallet';
  END IF;
  IF v_bal0 < 3.00 THEN
    RAISE EXCEPTION 'FAIL setup: largest admin wallet balance % is below 3.00', v_bal0;
  END IF;

  v_unit := jsonb_build_object(
    'network', 'MTN', 'service_key', 'data_mtn', 'beneficiary_phone', v_phone,
    'bundle_value', 'selftest-0141', 'bundle_display', '406.8MB', 'bundle_category', 'Non Expiry',
    'amount', 0.50, 'paid_amount', 0.45,
    'cashback_amount', 0.05, 'shop_share_amount', 0, 'cashback_rate', 2.5, 'cashback_share', 50,
    'cashback_provider', 'hubtel', 'expected_commission', 0.0125);

  -- catalog: columns, constraint, index, function posture ---------------------
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'hubtel_data_orders'
     AND ((column_name = 'special_group_id' AND data_type = 'uuid')
       OR (column_name = 'special_index' AND data_type = 'smallint'));
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL catalog: special columns found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.hubtel_data_orders'::regclass AND conname = 'hubtel_data_orders_special_check';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: special check found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'uq_hubtel_data_orders_special_child'
     AND indexdef LIKE 'CREATE UNIQUE INDEX%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: unique group index found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid = v_sig::regprocedure AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'];
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: function is not SECURITY DEFINER with search_path=public'; END IF;
  -- only the p_n signature exists (the pre-p_n draft is dropped)
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.proname = 'create_special_bundle_orders' AND p.pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: % create_special_bundle_orders overloads', v_n; END IF;

  -- grants: service_role only ------------------------------------------------
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL grants: anon can execute'; END IF;
  IF has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL grants: authenticated can execute'; END IF;
  IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL grants: service_role cannot execute'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = v_sig::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL grants: PUBLIC can execute'; END IF;

  -- deny_anon / deny_authenticated: a real call under each role is refused. Variables survive the sub-block
  -- rollback; the role itself reverts with it. A failed role switch is reported, never counted as a pass.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    v_called := false; v_got := NULL; v_seen := NULL;
    <<deny_role>>
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', v_role);
      v_seen := current_user;
      PERFORM public.create_special_bundle_orders(v_user, 'selftest-' || gen_random_uuid()::text, 1,
                                                  jsonb_build_array(v_unit), 0.45);
      v_called := true;
    EXCEPTION WHEN insufficient_privilege THEN
      v_got := SQLERRM;
    END deny_role;
    IF v_seen IS DISTINCT FROM v_role THEN
      RAISE EXCEPTION 'FAIL deny_%: could not switch role (current_user %, err %)', v_role, v_seen, v_got;
    END IF;
    IF v_called OR v_got IS NULL OR v_got NOT LIKE 'permission denied for function%' THEN
      RAISE EXCEPTION 'FAIL deny_%: called=% err=%', v_role, v_called, v_got;
    END IF;
  END LOOP;
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'FAIL deny: role did not revert (%)', current_user;
  END IF;

  -- 1. happy: N=3, one debit of 1.35, three pending+paid children --------------
  <<happy_case>>
  BEGIN
    v_res := public.create_special_bundle_orders(v_user, v_key1, 3,
               (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 1.35);
  END happy_case;
  IF (v_res->>'replay')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL happy: replay flag %', v_res; END IF;
  v_group := (v_res->>'group_id')::uuid;
  IF v_group IS NULL OR jsonb_array_length(v_res->'order_ids') <> 3 THEN RAISE EXCEPTION 'FAIL happy: result %', v_res; END IF;

  SELECT balance, COALESCE(total_spent, 0) INTO v_bal, v_spent FROM public.wallets WHERE user_id = v_user;
  IF v_bal <> v_bal0 - 1.35 THEN RAISE EXCEPTION 'FAIL happy: balance % expected %', v_bal, v_bal0 - 1.35; END IF;
  IF v_spent <> v_spent0 + 1.35 THEN RAISE EXCEPTION 'FAIL happy: total_spent % expected %', v_spent, v_spent0 + 1.35; END IF;

  SELECT count(*) INTO v_n FROM public.transactions t
   WHERE t.user_id = v_user AND t.reference_id = 'SPECIAL-' || v_group::text
     AND t.type = 'debit' AND t.source = 'standard_bundle' AND t.status = 'completed'
     AND t.amount = 1.35 AND t.balance_before = v_bal0 AND t.balance_after = v_bal0 - 1.35;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL happy: expected 1 matching transactions row, found %', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.hubtel_data_orders o
   WHERE o.special_group_id = v_group AND o.user_id = v_user
     AND o.channel = 'dashboard' AND o.network = 'MTN' AND o.service_key = 'data_mtn'
     AND o.beneficiary_phone = v_phone AND o.bundle_value = 'selftest-0141'
     AND o.bundle_display = '406.8MB' AND o.bundle_category = 'Non Expiry'
     AND o.status = 'pending' AND o.payment_status = 'paid'
     AND o.amount = 0.50 AND o.paid_amount = 0.45 AND o.cashback_amount = 0.05
     AND o.cashback_provider = 'hubtel' AND o.cashback_rate = 2.5 AND o.cashback_share = 50
     AND o.idempotency_key = v_key1 || ':' || o.special_index
     AND o.reference_code ~ '^SB-[0-9A-F]{12}$'
     AND o.hubtel_client_reference IS NULL AND o.paid_at IS NULL;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL happy: expected 3 matching children, found %', v_n; END IF;
  FOR r IN SELECT o.id, o.special_index FROM public.hubtel_data_orders o WHERE o.special_group_id = v_group LOOP
    IF (v_res->'order_ids'->>(r.special_index - 1))::uuid IS DISTINCT FROM r.id THEN
      RAISE EXCEPTION 'FAIL happy: order_ids not ordered by special_index';
    END IF;
  END LOOP;
  SELECT count(DISTINCT o.special_index) INTO v_n FROM public.hubtel_data_orders o
   WHERE o.special_group_id = v_group AND o.special_index BETWEEN 1 AND 3;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL happy: special_index is not 1..3'; END IF;

  -- 2. replay: same key => same group and ids, no second debit ------------------
  v_res2 := public.create_special_bundle_orders(v_user, v_key1, 3,
              (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 1.35);
  IF (v_res2->>'replay')::boolean IS DISTINCT FROM true OR v_res2->'group_id' <> v_res->'group_id'
     OR v_res2->'order_ids' <> v_res->'order_ids' THEN
    RAISE EXCEPTION 'FAIL replay: % vs %', v_res2, v_res;
  END IF;
  -- replay with a different (even invalid) payload still returns the group and never charges
  v_res2 := public.create_special_bundle_orders(v_user, v_key1, 0, '[]'::jsonb, 0);
  IF (v_res2->>'replay')::boolean IS DISTINCT FROM true OR v_res2->'order_ids' <> v_res->'order_ids' THEN
    RAISE EXCEPTION 'FAIL replay_other_payload: %', v_res2;
  END IF;
  SELECT balance INTO v_bal FROM public.wallets WHERE user_id = v_user;
  IF v_bal <> v_bal0 - 1.35 THEN RAISE EXCEPTION 'FAIL replay: balance moved to %', v_bal; END IF;
  SELECT count(*) INTO v_n FROM public.transactions WHERE user_id = v_user AND reference_id = 'SPECIAL-' || v_group::text;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL replay: % transactions rows', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.hubtel_data_orders WHERE user_id = v_user AND idempotency_key LIKE v_key1 || ':%';
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL replay: % children', v_n; END IF;

  -- 3. second_group: a different key buys again while funds allow ---------------
  v_res2 := public.create_special_bundle_orders(v_user, v_key2, 1, jsonb_build_array(v_unit), 0.45);
  IF (v_res2->>'replay')::boolean IS DISTINCT FROM false OR v_res2->'group_id' = v_res->'group_id'
     OR jsonb_array_length(v_res2->'order_ids') <> 1 THEN
    RAISE EXCEPTION 'FAIL second_group: %', v_res2;
  END IF;
  SELECT balance INTO v_bal FROM public.wallets WHERE user_id = v_user;
  IF v_bal <> v_bal0 - 1.80 THEN RAISE EXCEPTION 'FAIL second_group: balance % expected %', v_bal, v_bal0 - 1.80; END IF;

  -- no_cashback_group: no cashback (null) => paid_amount = amount is accepted and charged at face
  v_res2 := public.create_special_bundle_orders(v_user, v_key3, 1,
              jsonb_build_array(v_unit || '{"paid_amount":0.50,"cashback_amount":null}'::jsonb), 0.50);
  IF (v_res2->>'replay')::boolean IS DISTINCT FROM false OR jsonb_array_length(v_res2->'order_ids') <> 1 THEN
    RAISE EXCEPTION 'FAIL no_cashback_group: %', v_res2;
  END IF;
  SELECT count(*) INTO v_n FROM public.hubtel_data_orders
   WHERE id = (v_res2->'order_ids'->>0)::uuid AND paid_amount = 0.50 AND amount = 0.50 AND cashback_amount IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL no_cashback_group: child row'; END IF;
  SELECT balance INTO v_bal FROM public.wallets WHERE user_id = v_user;
  IF v_bal <> v_bal0 - 2.30 THEN RAISE EXCEPTION 'FAIL no_cashback_group: balance % expected %', v_bal, v_bal0 - 2.30; END IF;

  -- pair_check: a child cannot lose its index (CHECK hubtel_data_orders_special_check)
  v_got := NULL;
  <<pair_check>>
  BEGIN
    UPDATE public.hubtel_data_orders SET special_index = NULL WHERE special_group_id = v_group AND special_index = 1;
    v_got := 'NO_ERROR';
  EXCEPTION WHEN check_violation THEN
    v_got := 'check_violation';
  END pair_check;
  IF v_got <> 'check_violation' THEN RAISE EXCEPTION 'FAIL pair_check: %', v_got; END IF;

  -- 4. Every refusal: right code, no balance change, no child rows ---------------
  -- short_wallet: 50 units whose total is above the balance.
  SELECT balance INTO v_bal FROM public.wallets WHERE user_id = v_user;
  v_price := ceil((v_bal + 1) * 100 / 50) / 100.0;
  IF v_price >= 1000000 THEN RAISE EXCEPTION 'FAIL setup: balance too large for the short_wallet case'; END IF;

  -- Columns: case, p_n, p_rows, p_total, expected error.
  FOR v_case, v_pn, v_rows, v_total, v_err IN
    SELECT * FROM (VALUES
      ('short_wallet', 50,
         (SELECT jsonb_agg(v_unit || jsonb_build_object('amount', v_price, 'paid_amount', v_price, 'cashback_amount', 0))
            FROM generate_series(1, 50)),
         v_price * 50, 'INSUFFICIENT_FUNDS'),
      ('bad_total_over',  3, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 1.36::numeric, 'BAD_INPUT'),
      ('bad_total_under', 3, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 1.34::numeric, 'BAD_INPUT'),
      ('bad_total_face',  3, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 1.50::numeric, 'BAD_INPUT'),
      ('bad_total_null',  3, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), NULL::numeric, 'BAD_INPUT'),
      ('n_zero',          0, '[]'::jsonb, 0::numeric, 'BAD_INPUT'),
      ('n_51',           51, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 51)), 22.95::numeric, 'BAD_INPUT'),
      ('n_null',  NULL::int, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 1.35::numeric, 'BAD_INPUT'),
      -- n_mismatch: p_n disagrees with the row count, even when the total matches the rows
      ('n_mismatch_fewer_rows', 3, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 2)), 0.90::numeric, 'BAD_INPUT'),
      ('n_mismatch_more_rows',  2, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 1.35::numeric, 'BAD_INPUT'),
      ('rows_not_array',  1, v_unit, 0.45::numeric, 'BAD_INPUT'),
      ('row_not_object',  2, jsonb_build_array(v_unit, '1'::jsonb), 0.90::numeric, 'BAD_INPUT'),
      ('phone_mismatch',  2, jsonb_build_array(v_unit, v_unit || '{"beneficiary_phone":"233249990142"}'::jsonb), 0.90::numeric, 'BAD_INPUT'),
      ('paid_mismatch',   2, jsonb_build_array(v_unit, v_unit || '{"paid_amount":0.40}'::jsonb), 0.85::numeric, 'BAD_INPUT'),
      ('bad_phone',       1, jsonb_build_array(v_unit || '{"beneficiary_phone":"0249990141"}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      ('not_mtn',         1, jsonb_build_array(v_unit || '{"network":"TELECEL","service_key":"data_telecel"}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      ('wrong_service',   1, jsonb_build_array(v_unit || '{"service_key":"data_at"}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      ('three_dp_amount', 1, jsonb_build_array(v_unit || '{"amount":0.505}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      ('three_dp_paid',   1, jsonb_build_array(v_unit || '{"paid_amount":0.445}'::jsonb), 0.445::numeric, 'BAD_INPUT'),
      ('zero_paid',       1, jsonb_build_array(v_unit || '{"paid_amount":0}'::jsonb), 0::numeric, 'BAD_INPUT'),
      ('negative_amount', 1, jsonb_build_array(v_unit || '{"amount":-0.50}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      ('paid_above_face', 1, jsonb_build_array(v_unit || '{"paid_amount":0.60}'::jsonb), 0.60::numeric, 'BAD_INPUT'),
      ('amount_as_text',  1, jsonb_build_array(v_unit || '{"amount":"0.50"}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      ('missing_display', 1, jsonb_build_array(v_unit - 'bundle_display'), 0.45::numeric, 'BAD_INPUT'),
      ('unknown_field',   1, jsonb_build_array(v_unit || '{"status":"completed"}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      ('negative_cashback', 1, jsonb_build_array(v_unit || '{"cashback_amount":-1}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      -- paid_not_face_minus_cashback: under- and over-charge against face 0.50 - cashback 0.05 = 0.45
      ('paid_not_face_minus_cashback_under', 1, jsonb_build_array(v_unit || '{"paid_amount":0.44}'::jsonb), 0.44::numeric, 'BAD_INPUT'),
      ('paid_not_face_minus_cashback_over',  1, jsonb_build_array(v_unit || '{"paid_amount":0.46}'::jsonb), 0.46::numeric, 'BAD_INPUT'),
      ('paid_not_face_minus_cashback_3',     3, (SELECT jsonb_agg(v_unit || '{"paid_amount":0.40}'::jsonb) FROM generate_series(1, 3)), 1.20::numeric, 'BAD_INPUT'),
      -- paid_no_cashback: cashback absent / null => paid must equal face
      ('paid_no_cashback_null',   1, jsonb_build_array(v_unit || '{"cashback_amount":null}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      ('paid_no_cashback_absent', 1, jsonb_build_array(v_unit - 'cashback_amount'), 0.45::numeric, 'BAD_INPUT'),
      ('three_dp_cashback',   1, jsonb_build_array(v_unit || '{"cashback_amount":0.051}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      ('three_dp_cashback_consistent', 1, jsonb_build_array(v_unit || '{"cashback_amount":0.055,"paid_amount":0.445}'::jsonb), 0.445::numeric, 'BAD_INPUT'),
      ('three_dp_shop_share', 1, jsonb_build_array(v_unit || '{"shop_share_amount":0.005}'::jsonb), 0.45::numeric, 'BAD_INPUT'),
      ('negative_shop_share', 1, jsonb_build_array(v_unit || '{"shop_share_amount":-0.01}'::jsonb), 0.45::numeric, 'BAD_INPUT')
    ) AS t(c, pn, rws, tot, want)
  LOOP
    v_keyx := 'selftest-' || gen_random_uuid()::text;
    SELECT balance INTO v_bal FROM public.wallets WHERE user_id = v_user;
    v_res2 := NULL;
    <<refusal>>
    BEGIN
      v_res2 := public.create_special_bundle_orders(v_user, v_keyx, v_pn, v_rows, v_total);
      v_got := 'NO_ERROR';
    EXCEPTION WHEN OTHERS THEN
      v_got := SQLERRM;
    END refusal;
    IF v_got IS DISTINCT FROM v_err THEN
      RAISE EXCEPTION 'FAIL %: expected %, got % (result %)', v_case, v_err, v_got, v_res2;
    END IF;
    IF (SELECT balance FROM public.wallets WHERE user_id = v_user) <> v_bal THEN
      RAISE EXCEPTION 'FAIL %: balance moved', v_case;
    END IF;
    IF EXISTS (SELECT 1 FROM public.hubtel_data_orders WHERE user_id = v_user AND idempotency_key LIKE v_keyx || ':%') THEN
      RAISE EXCEPTION 'FAIL %: child rows written', v_case;
    END IF;
  END LOOP;

  -- key_used_by_normal_order: a plain (non-Special) dashboard row already holds key:1 => BAD_INPUT, no debit
  INSERT INTO public.hubtel_data_orders (reference_code, user_id, network, service_key, beneficiary_phone,
                                         bundle_value, bundle_display, bundle_category, amount, idempotency_key)
  VALUES ('SB-SELFTEST' || upper(substr(md5(v_key4), 1, 8)), v_user, 'MTN', 'data_mtn', v_phone,
          'selftest-0141', '406.8MB', 'Non Expiry', 0.50, v_key4 || ':1');
  SELECT balance INTO v_bal FROM public.wallets WHERE user_id = v_user;
  v_got := NULL;
  <<key_used_by_normal_order>>
  BEGIN
    PERFORM public.create_special_bundle_orders(v_user, v_key4, 1, jsonb_build_array(v_unit), 0.45);
    v_got := 'NO_ERROR';
  EXCEPTION WHEN OTHERS THEN
    v_got := SQLERRM;
  END key_used_by_normal_order;
  IF v_got IS DISTINCT FROM 'BAD_INPUT' THEN RAISE EXCEPTION 'FAIL key_used_by_normal_order: got %', v_got; END IF;
  IF (SELECT balance FROM public.wallets WHERE user_id = v_user) <> v_bal THEN
    RAISE EXCEPTION 'FAIL key_used_by_normal_order: balance moved';
  END IF;
  SELECT count(*) INTO v_n FROM public.hubtel_data_orders WHERE user_id = v_user AND idempotency_key LIKE v_key4 || ':%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL key_used_by_normal_order: % rows for the key', v_n; END IF;

  -- bad_key / null_user -------------------------------------------------------
  FOREACH v_keyx IN ARRAY ARRAY['short', 'has:colon-123', 'has space 123', repeat('a', 65)] LOOP
    <<bad_key>>
    BEGIN
      PERFORM public.create_special_bundle_orders(v_user, v_keyx, 1, jsonb_build_array(v_unit), 0.45);
      v_got := 'NO_ERROR';
    EXCEPTION WHEN OTHERS THEN
      v_got := SQLERRM;
    END bad_key;
    IF v_got <> 'BAD_INPUT' THEN RAISE EXCEPTION 'FAIL bad_key %: got %', v_keyx, v_got; END IF;
  END LOOP;
  <<null_user>>
  BEGIN
    PERFORM public.create_special_bundle_orders(NULL, 'selftest-' || gen_random_uuid()::text, 1, jsonb_build_array(v_unit), 0.45);
    v_got := 'NO_ERROR';
  EXCEPTION WHEN OTHERS THEN
    v_got := SQLERRM;
  END null_user;
  IF v_got <> 'BAD_INPUT' THEN RAISE EXCEPTION 'FAIL null_user: got %', v_got; END IF;

  -- final: exactly the three good debits happened (1.35 + 0.45 + 0.50) -----------
  SELECT balance, COALESCE(total_spent, 0) INTO v_bal, v_spent FROM public.wallets WHERE user_id = v_user;
  IF v_bal <> v_bal0 - 2.30 OR v_spent <> v_spent0 + 2.30 THEN
    RAISE EXCEPTION 'FAIL final: balance % spent % (expected % / %)', v_bal, v_spent, v_bal0 - 2.30, v_spent0 + 2.30;
  END IF;

  -- Always roll back. -------------------------------------------------------
  RAISE EXCEPTION 'SELFTEST_OK 0141: all scenarios passed; rolling back';
END $selftest$;
