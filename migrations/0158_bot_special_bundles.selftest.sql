-- 0158_bot_special_bundles.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0158_bot_special_bundles.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as lib/standard-bundles/bot-special-migration.test.ts does:
--   1. 0158_bot_special_bundles.sql with BEGIN kept (and both SET LOCALs) and ONLY its final
--      transaction-ending line removed; the trailing "Verify after apply" comment lines may stay;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: every sub-block is labelled and the block closes with `END $selftest$;`.
--   The migration's function body closes with `END` + `$fn$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the constraint, the
-- function and every child order are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any
-- 'FAIL ...' or other error means it failed. If the client keeps the session open, send `ROLLBACK;`.
--
-- What it cannot cover: two calls at once. That relies on uq_hubtel_data_orders_bots_idem and the unique_violation
-- handler; see the migration header. The same-key replay is covered sequentially.
--
-- Money: "no money moves" is proved from the function's own source (prosrc) and by the absence of a history row for the
-- group, not by comparing wallet totals, because live traffic moves those totals during a production dry run.
-- The PGlite block of the test file also compares the totals, where nothing else is writing.
--
-- Scenarios (labels): catalog, grants, deny_anon / deny_authenticated (real call under SET LOCAL ROLE), happy (N=3, shop),
-- main_context, replay (same key, and same key with another payload), replay_other_shop, fee, fee_null, other_buyer,
-- no_partial_group, key_used_by_normal_order, the refusals (bad_total_*, rows_differ, not_mtn,
-- paid_not_face_minus_cashback_*, bad_surface_*, share_without_shop, bad_buyer_*, fee_*, ...), dashboard_special, and
-- the CHECK refusals named by constraint: storefront_special, api_special, bots_not_mtn, bots_without_surface.
--
-- No real user, shop or wallet is read or written: user and shop ids are random (neither column has a foreign key on
-- hubtel_data_orders). Test phones 233249990158 to 233249990161 are unique to this selftest. Unit: face 3.00,
-- pay 2.95, cashback 0.05, shop share 0.02.

DO $selftest$
DECLARE
  v_sig     CONSTANT text := 'public.create_bot_special_bundle_orders(text,text,uuid,text,integer,jsonb,numeric)';
  v_surface CONSTANT text := 'hubtel_ussd';
  v_buyer   CONSTANT text := '233249990158';
  v_phone   CONSTANT text := '233249990159';
  v_shop    uuid := gen_random_uuid();
  v_unit    jsonb;
  v_key1    text := 'selftest-' || gen_random_uuid()::text;
  v_key2    text := 'selftest-' || gen_random_uuid()::text;
  v_keyx    text;
  v_res     jsonb;
  v_res2    jsonb;
  v_group   uuid;
  v_got     text;
  v_role    text;
  v_seen    text;
  v_called  boolean;
  v_n       int;
  v_case    text;
  v_sf      text;
  v_by      text;
  v_sh      uuid;
  v_pn      int;
  v_rows    jsonb;
  v_total   numeric;
  v_src     text;
  v_channel text;
  v_network text;
  v_detail  text;
BEGIN
  v_unit := jsonb_build_object(
    'network', 'MTN', 'service_key', 'data_mtn', 'beneficiary_phone', v_phone,
    'bundle_value', 'selftest-0158', 'bundle_display', '406.89MB', 'bundle_category', 'Non Expiry',
    'amount', 3.00, 'paid_amount', 2.95,
    'cashback_amount', 0.05, 'shop_share_amount', 0.02, 'cashback_rate', 2.5, 'cashback_share', 50,
    'cashback_provider', 'hubtel', 'expected_commission', 0.075);

  -- catalog: function posture, one overload, and no reference to any money table -----------------
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid = v_sig::regprocedure AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'];
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: function is not SECURITY DEFINER with search_path=public'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.proname = 'create_bot_special_bundle_orders' AND p.pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: % overloads', v_n; END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_sig::regprocedure;
  IF v_src ~* '(wallet|transactions|deduct_)' THEN RAISE EXCEPTION 'FAIL catalog: the body names a money table'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.proname = 'create_special_bundle_orders' AND p.pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: dashboard RPC overloads %', v_n; END IF;

  -- grants: service_role only --------------------------------------------------------------------
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
      PERFORM public.create_bot_special_bundle_orders(v_surface, v_buyer, v_shop, 'selftest-' || gen_random_uuid()::text, 1,
                                                      jsonb_build_array(v_unit), 2.95);
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

  -- happy: N=3 in shop context ---------------------------------------------------------------------
  v_res := public.create_bot_special_bundle_orders(v_surface, v_buyer, v_shop, v_key1, 3,
             (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 8.85);
  IF (v_res->>'replay')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL happy: replay flag %', v_res; END IF;
  v_group := (v_res->>'group_id')::uuid;
  IF v_group IS NULL OR jsonb_array_length(v_res->'order_ids') <> 3 THEN RAISE EXCEPTION 'FAIL happy: result %', v_res; END IF;

  SELECT count(*) INTO v_n FROM public.hubtel_data_orders o
   WHERE o.special_group_id = v_group AND o.user_id IS NULL
     AND o.channel = 'bots' AND o.bot_surface = v_surface AND o.buyer_phone = v_buyer AND o.shop_id = v_shop
     AND o.buyer_name IS NULL AND o.buyer_email IS NULL
     AND o.network = 'MTN' AND o.service_key = 'data_mtn' AND o.beneficiary_phone = v_phone
     AND o.bundle_value = 'selftest-0158' AND o.bundle_display = '406.89MB' AND o.bundle_category = 'Non Expiry'
     AND o.status = 'pending' AND o.payment_status = 'unpaid'
     AND o.amount = 3.00 AND o.paid_amount = 2.95 AND o.payment_fee_amount = 0
     AND o.cashback_amount = 0.05 AND o.shop_share_amount = 0.02
     AND o.cashback_provider = 'hubtel' AND o.cashback_rate = 2.5 AND o.cashback_share = 50
     AND o.idempotency_key = v_key1 || ':' || o.special_index
     AND o.reference_code ~ '^SB-[0-9A-F]{12}$'
     AND o.hubtel_client_reference IS NULL AND o.paid_at IS NULL;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL happy: expected 3 matching children, found %', v_n; END IF;
  IF (SELECT jsonb_agg(o.id ORDER BY o.special_index) FROM public.hubtel_data_orders o WHERE o.special_group_id = v_group)
     IS DISTINCT FROM v_res->'order_ids' THEN
    RAISE EXCEPTION 'FAIL happy: order_ids not ordered by special_index';
  END IF;
  SELECT count(DISTINCT o.special_index) INTO v_n FROM public.hubtel_data_orders o
   WHERE o.special_group_id = v_group AND o.special_index BETWEEN 1 AND 3;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL happy: special_index is not 1..3'; END IF;
  -- no history row: a wallet purchase would have written one with this reference.
  SELECT count(*) INTO v_n FROM public.transactions t WHERE t.reference_id = 'SPECIAL-' || v_group::text;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL happy: % history rows', v_n; END IF;

  -- replay: same key => same group and ids, nothing new ---------------------------------------------
  v_res2 := public.create_bot_special_bundle_orders(v_surface, v_buyer, v_shop, v_key1, 3,
              (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 8.85);
  IF (v_res2->>'replay')::boolean IS DISTINCT FROM true OR v_res2->'group_id' <> v_res->'group_id'
     OR v_res2->'order_ids' <> v_res->'order_ids' THEN
    RAISE EXCEPTION 'FAIL replay: % vs %', v_res2, v_res;
  END IF;
  -- replay with a different (even invalid) payload under the same shop still returns the group
  v_res2 := public.create_bot_special_bundle_orders(v_surface, v_buyer, v_shop, v_key1, 0, '[]'::jsonb, 0);
  IF (v_res2->>'replay')::boolean IS DISTINCT FROM true OR v_res2->'order_ids' <> v_res->'order_ids' THEN
    RAISE EXCEPTION 'FAIL replay_other_payload: %', v_res2;
  END IF;
  -- replay_other_shop: a replay never crosses shops, including from a shop to the main code (NULL)
  FOREACH v_keyx IN ARRAY ARRAY[gen_random_uuid()::text, NULL] LOOP
    v_got := NULL;
    <<replay_other_shop>>
    BEGIN
      PERFORM public.create_bot_special_bundle_orders(v_surface, v_buyer, v_keyx::uuid, v_key1, 3,
                (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 8.85);
      v_got := 'NO_ERROR';
    EXCEPTION WHEN OTHERS THEN
      v_got := SQLERRM;
    END replay_other_shop;
    IF v_got IS DISTINCT FROM 'BAD_INPUT' THEN RAISE EXCEPTION 'FAIL replay_other_shop: got %', v_got; END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM public.hubtel_data_orders WHERE buyer_phone = v_buyer AND idempotency_key LIKE v_key1 || ':%';
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL replay: % children', v_n; END IF;

  -- fee: a rail fee is accepted, can lift paid above face, and is stored on every child ------------------
  v_keyx := 'selftest-' || gen_random_uuid()::text;
  v_res2 := public.create_bot_special_bundle_orders(v_surface, v_buyer, v_shop, v_keyx, 2,
              (SELECT jsonb_agg(v_unit || '{"payment_fee_amount":0.10,"paid_amount":3.05}'::jsonb) FROM generate_series(1, 2)), 6.10);
  SELECT count(*) INTO v_n FROM public.hubtel_data_orders
   WHERE special_group_id = (v_res2->>'group_id')::uuid AND payment_fee_amount = 0.10 AND paid_amount = 3.05 AND amount = 3.00;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL fee: % matching children', v_n; END IF;
  -- fee_null: null counts as 0, and is stored as 0
  v_keyx := 'selftest-' || gen_random_uuid()::text;
  v_res2 := public.create_bot_special_bundle_orders(v_surface, v_buyer, v_shop, v_keyx, 1,
              jsonb_build_array(v_unit || '{"payment_fee_amount":null}'::jsonb), 2.95);
  SELECT count(*) INTO v_n FROM public.hubtel_data_orders
   WHERE id = (v_res2->'order_ids'->>0)::uuid AND payment_fee_amount = 0;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL fee_null: child row'; END IF;

  -- other_buyer: the same key from another number is its own group ----------------------------------
  v_res2 := public.create_bot_special_bundle_orders(v_surface, '233249990160', v_shop, v_key1, 1, jsonb_build_array(v_unit), 2.95);
  IF (v_res2->>'replay')::boolean IS DISTINCT FROM false OR v_res2->'group_id' = v_res->'group_id' THEN
    RAISE EXCEPTION 'FAIL other_buyer: %', v_res2;
  END IF;

  -- main_context: no shop, with a zero share and with no share ---------------------------------------
  v_keyx := 'selftest-' || gen_random_uuid()::text;
  v_res2 := public.create_bot_special_bundle_orders(v_surface, v_buyer, NULL, v_keyx, 1,
              jsonb_build_array(v_unit || '{"shop_share_amount":0}'::jsonb), 2.95);
  SELECT count(*) INTO v_n FROM public.hubtel_data_orders
   WHERE id = (v_res2->'order_ids'->>0)::uuid AND shop_id IS NULL AND shop_share_amount = 0;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL main_context: zero share row'; END IF;
  v_keyx := 'selftest-' || gen_random_uuid()::text;
  v_res2 := public.create_bot_special_bundle_orders(v_surface, v_buyer, NULL, v_keyx, 1,
              jsonb_build_array((v_unit - 'shop_share_amount') || '{"paid_amount":3.00,"cashback_amount":null}'::jsonb), 3.00);
  SELECT count(*) INTO v_n FROM public.hubtel_data_orders
   WHERE id = (v_res2->'order_ids'->>0)::uuid AND shop_id IS NULL AND shop_share_amount IS NULL AND paid_amount = 3.00;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL main_context: no cashback row'; END IF;

  -- Every refusal: BAD_INPUT and no rows for the key ---------------------------------------------------
  -- Columns: case, surface, buyer, shop, p_n, p_rows, p_total.
  FOR v_case, v_sf, v_by, v_sh, v_pn, v_rows, v_total IN
    SELECT * FROM (VALUES
      ('bad_total_over',  v_surface, v_buyer, v_shop, 3, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 8.86::numeric),
      ('bad_total_under', v_surface, v_buyer, v_shop, 3, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 8.84::numeric),
      ('bad_total_face',  v_surface, v_buyer, v_shop, 3, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 9.00::numeric),
      ('bad_total_null',  v_surface, v_buyer, v_shop, 3, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), NULL::numeric),
      ('rows_differ',     v_surface, v_buyer, v_shop, 2, jsonb_build_array(v_unit, v_unit || '{"beneficiary_phone":"233249990161"}'::jsonb), 5.90::numeric),
      ('rows_not_array',  v_surface, v_buyer, v_shop, 1, v_unit, 2.95::numeric),
      ('row_not_object',  v_surface, v_buyer, v_shop, 2, jsonb_build_array(v_unit, '1'::jsonb), 5.90::numeric),
      ('not_mtn',         v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"network":"TELECEL","service_key":"data_telecel"}'::jsonb), 2.95::numeric),
      ('not_mtn_service', v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"service_key":"data_at"}'::jsonb), 2.95::numeric),
      ('paid_not_face_minus_cashback_over',  v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"paid_amount":2.96}'::jsonb), 2.96::numeric),
      ('paid_not_face_minus_cashback_under', v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"paid_amount":2.94}'::jsonb), 2.94::numeric),
      ('paid_no_cashback', v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit - 'cashback_amount'), 2.95::numeric),
      ('bad_surface_ussd',     'ussd',        v_buyer, v_shop, 1, jsonb_build_array(v_unit), 2.95::numeric),
      ('bad_surface_whatsapp', 'whatsapp',    v_buyer, v_shop, 1, jsonb_build_array(v_unit), 2.95::numeric),
      ('bad_surface_case',     'HUBTEL_USSD', v_buyer, v_shop, 1, jsonb_build_array(v_unit), 2.95::numeric),
      ('bad_surface_null',     NULL::text,    v_buyer, v_shop, 1, jsonb_build_array(v_unit), 2.95::numeric),
      ('share_without_shop',   v_surface, v_buyer, NULL::uuid, 1, jsonb_build_array(v_unit), 2.95::numeric),
      ('bad_buyer_local',      v_surface, '0249990158',    v_shop, 1, jsonb_build_array(v_unit), 2.95::numeric),
      ('bad_buyer_short',      v_surface, '23324999015',   v_shop, 1, jsonb_build_array(v_unit), 2.95::numeric),
      ('bad_buyer_newline',    v_surface, v_buyer || E'\n', v_shop, 1, jsonb_build_array(v_unit), 2.95::numeric),
      ('bad_buyer_null',       v_surface, NULL::text,      v_shop, 1, jsonb_build_array(v_unit), 2.95::numeric),
      ('n_zero',          v_surface, v_buyer, v_shop, 0, '[]'::jsonb, 0::numeric),
      ('n_51',            v_surface, v_buyer, v_shop, 51, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 51)), 150.45::numeric),
      ('n_null',          v_surface, v_buyer, v_shop, NULL::int, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 8.85::numeric),
      ('n_mismatch',      v_surface, v_buyer, v_shop, 2, (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 8.85::numeric),
      ('bad_phone',       v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"beneficiary_phone":"0249990159"}'::jsonb), 2.95::numeric),
      ('three_dp_amount', v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"amount":3.005}'::jsonb), 2.95::numeric),
      ('amount_as_text',  v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"amount":"3.00"}'::jsonb), 2.95::numeric),
      ('missing_display', v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit - 'bundle_display'), 2.95::numeric),
      ('unknown_field',   v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"status":"completed"}'::jsonb), 2.95::numeric),
      ('fee_paid_wrong',  v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"payment_fee_amount":0.10}'::jsonb), 2.95::numeric),
      ('fee_negative',    v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"payment_fee_amount":-0.10,"paid_amount":2.85}'::jsonb), 2.85::numeric),
      ('fee_three_dp',    v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"payment_fee_amount":0.105,"paid_amount":3.05}'::jsonb), 3.05::numeric),
      ('fee_as_text',     v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"payment_fee_amount":"0.10","paid_amount":3.05}'::jsonb), 3.05::numeric),
      ('negative_share',  v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"shop_share_amount":-0.01}'::jsonb), 2.95::numeric),
      ('three_dp_share',  v_surface, v_buyer, v_shop, 1, jsonb_build_array(v_unit || '{"shop_share_amount":0.005}'::jsonb), 2.95::numeric)
    ) AS t(c, sf, by_, sh, pn, rws, tot)
  LOOP
    v_keyx := 'selftest-' || gen_random_uuid()::text;
    v_res2 := NULL;
    <<refusal>>
    BEGIN
      v_res2 := public.create_bot_special_bundle_orders(v_sf, v_by, v_sh, v_keyx, v_pn, v_rows, v_total);
      v_got := 'NO_ERROR';
    EXCEPTION WHEN OTHERS THEN
      v_got := SQLERRM;
    END refusal;
    IF v_got IS DISTINCT FROM 'BAD_INPUT' THEN
      RAISE EXCEPTION 'FAIL %: expected BAD_INPUT, got % (result %)', v_case, v_got, v_res2;
    END IF;
    IF EXISTS (SELECT 1 FROM public.hubtel_data_orders WHERE idempotency_key LIKE v_keyx || ':%') THEN
      RAISE EXCEPTION 'FAIL %: rows written', v_case;
    END IF;
  END LOOP;

  -- bad_key -------------------------------------------------------------------------------------------
  FOREACH v_keyx IN ARRAY ARRAY['short', 'has:colon-123', 'has space 123', repeat('a', 65)] LOOP
    <<bad_key>>
    BEGIN
      PERFORM public.create_bot_special_bundle_orders(v_surface, v_buyer, v_shop, v_keyx, 1, jsonb_build_array(v_unit), 2.95);
      v_got := 'NO_ERROR';
    EXCEPTION WHEN OTHERS THEN
      v_got := SQLERRM;
    END bad_key;
    IF v_got <> 'BAD_INPUT' THEN RAISE EXCEPTION 'FAIL bad_key %: got %', v_keyx, v_got; END IF;
  END LOOP;

  -- key_used_by_normal_order: a plain bot row holds key:1 => BAD_INPUT, not handed back as a group --------
  INSERT INTO public.hubtel_data_orders (reference_code, channel, bot_surface, buyer_phone, network, service_key, beneficiary_phone,
                                         bundle_value, bundle_display, bundle_category, amount, idempotency_key)
  VALUES ('SB-SELFTEST1' || upper(substr(md5(v_key2), 1, 6)), 'bots', v_surface, v_buyer, 'MTN', 'data_mtn', v_phone,
          'selftest-0158', '406.89MB', 'Non Expiry', 3.00, v_key2 || ':1');
  v_got := NULL;
  <<key_used_by_normal_order>>
  BEGIN
    PERFORM public.create_bot_special_bundle_orders(v_surface, v_buyer, v_shop, v_key2, 1, jsonb_build_array(v_unit), 2.95);
    v_got := 'NO_ERROR';
  EXCEPTION WHEN OTHERS THEN
    v_got := SQLERRM;
  END key_used_by_normal_order;
  IF v_got IS DISTINCT FROM 'BAD_INPUT' THEN RAISE EXCEPTION 'FAIL key_used_by_normal_order: got %', v_got; END IF;

  -- no_partial_group: a clash on child 2 of 3 rolls back child 1 and raises the fixed GROUP_CONFLICT, no phone ---
  v_keyx := 'selftest-' || gen_random_uuid()::text;
  INSERT INTO public.hubtel_data_orders (reference_code, channel, bot_surface, buyer_phone, network, service_key, beneficiary_phone,
                                         bundle_value, bundle_display, bundle_category, amount, idempotency_key)
  VALUES ('SB-SELFTEST2' || upper(substr(md5(v_keyx), 1, 6)), 'bots', v_surface, v_buyer, 'MTN', 'data_mtn', v_phone,
          'selftest-0158', '406.89MB', 'Non Expiry', 3.00, v_keyx || ':2');
  v_got := NULL;
  <<no_partial_group>>
  BEGIN
    PERFORM public.create_bot_special_bundle_orders(v_surface, v_buyer, v_shop, v_keyx, 3,
              (SELECT jsonb_agg(v_unit) FROM generate_series(1, 3)), 8.85);
    v_got := 'NO_ERROR';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_got := SQLERRM;
  END no_partial_group;
  IF v_got IS DISTINCT FROM 'GROUP_CONFLICT' THEN RAISE EXCEPTION 'FAIL no_partial_group: got %', v_got; END IF;
  IF v_detail LIKE '%' || v_buyer || '%' THEN RAISE EXCEPTION 'FAIL no_partial_group: the phone is in DETAIL'; END IF;
  SELECT count(*) INTO v_n FROM public.hubtel_data_orders WHERE idempotency_key LIKE v_keyx || ':%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL no_partial_group: % rows for the key', v_n; END IF;

  -- The CHECK, by direct inserts ------------------------------------------------------------------------
  -- dashboard_special: still inserts. A random user id; user_id has no foreign key.
  INSERT INTO public.hubtel_data_orders (reference_code, user_id, channel, network, service_key, beneficiary_phone,
                                         bundle_value, bundle_display, bundle_category, amount, idempotency_key,
                                         special_group_id, special_index)
  VALUES ('SB-SELFTEST3' || upper(substr(md5(v_key2), 1, 6)), gen_random_uuid(), 'dashboard', 'MTN', 'data_mtn', v_phone,
          'selftest-0158', '406.89MB', 'Non Expiry', 3.00, v_key2 || ':dash', gen_random_uuid(), 1);

  -- Columns: case, channel, surface, network.
  FOR v_case, v_channel, v_sf, v_network IN
    SELECT * FROM (VALUES
      ('storefront_special',   'storefront', NULL::text,    'MTN'),
      ('api_special',          'api',        NULL::text,    'MTN'),
      ('bots_not_mtn',         'bots',       'hubtel_ussd', 'TELECEL'),
      ('bots_without_surface', 'bots',       NULL::text,    'MTN')
    ) AS t(c, ch, sf, net)
  LOOP
    v_got := NULL;
    <<check_refusal>>
    BEGIN
      -- 0123's constraint is checked first (Postgres checks by name), so it would hide this one. The drop rolls back
      -- with this sub-block.
      IF v_case = 'bots_without_surface' THEN
        ALTER TABLE public.hubtel_data_orders DROP CONSTRAINT hubtel_data_orders_bot_surface_required;
      END IF;
      INSERT INTO public.hubtel_data_orders (reference_code, channel, bot_surface, buyer_phone, shop_id, network, service_key, beneficiary_phone,
                                             bundle_value, bundle_display, bundle_category, amount, idempotency_key,
                                             special_group_id, special_index)
      VALUES ('SB-' || upper(substr(md5(v_case), 1, 12)), v_channel, v_sf, v_buyer, v_shop, v_network, 'data_mtn', v_phone,
              'selftest-0158', '406.89MB', 'Non Expiry', 3.00, 'selftest-' || gen_random_uuid()::text,
              gen_random_uuid(), 1);
      v_got := 'NO_ERROR';
    EXCEPTION WHEN check_violation THEN
      v_got := SQLERRM;
    END check_refusal;
    -- This migration's own CHECK must be the one refusing: any other check_violation is a failure.
    IF v_got IS NULL OR v_got NOT LIKE '%hubtel_data_orders_special_check%' THEN
      RAISE EXCEPTION 'FAIL %: got %', v_case, v_got;
    END IF;
  END LOOP;
  -- the drop above rolled back
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.hubtel_data_orders'::regclass AND conname = 'hubtel_data_orders_bot_surface_required';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL bots_without_surface: 0123 constraint not restored'; END IF;

  -- Always roll back. -------------------------------------------------------
  RAISE EXCEPTION 'SELFTEST_OK 0158: all scenarios passed; rolling back';
END $selftest$;
