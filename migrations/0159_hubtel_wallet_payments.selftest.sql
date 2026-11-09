-- 0159_hubtel_wallet_payments.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0159_hubtel_wallet_payments.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as lib/ussd-hubtel/wallet-migration.test.ts does:
--   1. 0159_hubtel_wallet_payments.sql with BEGIN kept (and both SET LOCALs) and ONLY its final
--      transaction-ending line removed; the trailing "Verify after apply" comment lines may stay;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: every sub-block is labelled and the block closes with `END $selftest$;`.
--   The migration's function body closes with `END` + `$fn$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the table, the function,
-- every wallet deduction, transactions row, payment row and hubtel_transactions row are rolled back. PASSES when the
-- error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed. If the client keeps the session
-- open, send `ROLLBACK;`.
--
-- What it cannot cover: two sessions at once. Those rely on the wallet FOR UPDATE and the unique indexes; see the
-- migration header. The PGlite block of the test file drives the unique_violation handler.
--
-- Scenarios (labels): catalog, order_id_types, grants, deny_anon / deny_authenticated (a real call and a real table read
-- under SET LOCAL ROLE), happy, replay, replay_other_amount, session_other_order, session_other_user,
-- other_session_same_order, already_carted, already_carted_other_session, short_wallet, no_wallet, the refusals
-- (bad_table_*, bad_source_*, amount_zero, amount_negative, amount_three_dp, ...), order_table_check, service_role_pays
-- (a real paying call under SET LOCAL ROLE service_role, which cannot itself insert), every_table_and_source,
-- debit_already_recorded, final_balance.
--
-- Picks the admin (public.users.role = 'admin', joined to auth.users and public.wallets) with the largest wallet
-- balance, and holds that wallet's row lock from the start, so live traffic cannot move the totals compared below. The
-- balance must be >= 2.00. transactions.user_id has a foreign key, so a random user cannot be used for a debit. Order
-- ids are random and have no row: the RPC does not read the order. Test phone 233249990162 is unique to this selftest.

DO $selftest$
DECLARE
  v_sig     CONSTANT text := 'public.pay_hubtel_order_from_wallet(text,uuid,text,uuid,numeric,text,text)';
  v_tbl     CONSTANT text := 'public.hubtel_wallet_payments';
  v_phone   CONSTANT text := '233249990162';
  v_desc    CONSTANT text := 'selftest-0159 to 233249990162';
  v_source  CONSTANT text := 'ussd_data_purchase';
  v_user    uuid;
  v_other   uuid := gen_random_uuid();
  v_bal0    numeric;
  v_spent0  numeric;
  v_bal     numeric;
  v_spent   numeric;
  v_short   numeric;
  v_session text := 'selftest-' || gen_random_uuid()::text;
  v_order   uuid := gen_random_uuid();
  v_order2  uuid := gen_random_uuid();
  v_carted  uuid := gen_random_uuid();
  v_sess2   text;
  v_res     jsonb;
  v_res2    jsonb;
  v_got     text;
  v_errdet  text;
  v_want    text;
  v_role    text;
  v_seen    text;
  v_called  boolean;
  v_n       int;
  v_paid    numeric := 0;
  v_case    text;
  v_cs      text;
  v_cu      uuid;
  v_ct      text;
  v_co      uuid;
  v_ca      numeric;
  v_cso     text;
  v_cd      text;
  v_src     text;
  v_priv    text;
BEGIN
  -- Setup -------------------------------------------------------------------
  SELECT u.id, w.balance, COALESCE(w.total_spent, 0) INTO v_user, v_bal0, v_spent0
    FROM public.users u
    JOIN auth.users au ON au.id = u.id
    JOIN public.wallets w ON w.user_id = u.id
   WHERE u.role = 'admin'
   ORDER BY w.balance DESC, u.id
   LIMIT 1
   FOR UPDATE OF w;
  IF v_user IS NULL THEN RAISE EXCEPTION 'FAIL setup: no admin with a wallet'; END IF;
  IF v_bal0 < 2.00 THEN RAISE EXCEPTION 'FAIL setup: largest admin wallet balance % is below 2.00', v_bal0; END IF;
  IF v_bal0 >= 999999 THEN RAISE EXCEPTION 'FAIL setup: admin wallet too large to overdraw inside the amount cap'; END IF;

  -- catalog: the table, its keys, RLS, and the function's posture ----------------
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'hubtel_wallet_payments';
  IF v_n <> 11 THEN RAISE EXCEPTION 'FAIL catalog: % columns', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'hubtel_wallet_payments' AND indexdef LIKE 'CREATE UNIQUE INDEX%'
     AND (indexdef LIKE '%(session_id)%' OR indexdef LIKE '%(order_table, order_id)%');
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL catalog: % unique keys', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'hubtel_wallet_payments' AND indexdef LIKE '%(created_at) WHERE (state = ''debited''::text)%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: partial index found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_class WHERE oid = v_tbl::regclass AND relrowsecurity;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: RLS is off'; END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'hubtel_wallet_payments';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL catalog: % policies', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid = v_sig::regprocedure AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'];
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: function is not SECURITY DEFINER with search_path=public'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.proname = 'pay_hubtel_order_from_wallet' AND p.pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: % overloads', v_n; END IF;
  -- The RPC leaves the order row alone: no order table follows an UPDATE, and no dynamic SQL could hide one.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_sig::regprocedure;
  IF v_src ~* 'UPDATE\s+(public\.)?(ussd_orders|airtime_orders|results_checker_orders|results_check_requests)\M' OR v_src ~* '\mEXECUTE\M' THEN
    RAISE EXCEPTION 'FAIL catalog: the body could update an order';
  END IF;

  -- order_id_types: every order table's id is a uuid, so p_order can name its row ----------------
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name = 'id' AND data_type = 'uuid'
     AND table_name IN ('ussd_orders','airtime_orders','results_checker_orders','results_check_requests');
  IF v_n <> 4 THEN RAISE EXCEPTION 'FAIL order_id_types: % of 4 uuid ids', v_n; END IF;

  -- grants: service_role only ----------------------------------------------------
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL grants: anon can execute'; END IF;
  IF has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL grants: authenticated can execute'; END IF;
  IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL grants: service_role cannot execute'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = v_sig::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL grants: PUBLIC can execute'; END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege(v_role, v_tbl, v_priv) THEN RAISE EXCEPTION 'FAIL grants: % has % on the table', v_role, v_priv; END IF;
    END LOOP;
  END LOOP;
  IF NOT has_table_privilege('service_role', v_tbl, 'SELECT') OR NOT has_table_privilege('service_role', v_tbl, 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL grants: service_role cannot read or update the table';
  END IF;
  -- 0060's default privileges would give service_role ALL here: a payment row must only ever come with its debit.
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('service_role', v_tbl, v_priv) THEN RAISE EXCEPTION 'FAIL grants: service_role has % on the table', v_priv; END IF;
  END LOOP;

  -- order_table_check: the table itself refuses a table outside the four ------------------
  v_got := NULL;
  <<order_table_check>>
  BEGIN
    INSERT INTO public.hubtel_wallet_payments (session_id, order_table, order_id, user_id, amount)
    VALUES ('selftest-' || gen_random_uuid()::text, 'ussd_shop_orders', gen_random_uuid(), v_user, 0.01);
    v_got := 'NO_ERROR';
  EXCEPTION WHEN check_violation THEN
    v_got := SQLERRM;
  END order_table_check;
  IF v_got IS NULL OR v_got NOT LIKE '%hubtel_wallet_payments_order_table_check%' THEN
    RAISE EXCEPTION 'FAIL order_table_check: got %', v_got;
  END IF;

  -- service_role_pays: the RPC runs as its owner, so it still inserts for a role that cannot. The block always raises at
  -- its end, which undoes the payment and the role; the variables survive. The role really is service_role, or this fails.
  v_got := NULL; v_seen := NULL; v_res2 := NULL; v_called := false;
  <<service_role_pays>>
  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    v_seen := current_user;
    v_res2 := public.pay_hubtel_order_from_wallet('selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 0.01, v_source, v_desc);
    <<service_role_insert>>
    BEGIN
      INSERT INTO public.hubtel_wallet_payments (session_id, order_table, order_id, user_id, amount)
      VALUES ('selftest-' || gen_random_uuid()::text, 'ussd_orders', gen_random_uuid(), v_user, 0.01);
      v_called := true;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END service_role_insert;
    RAISE EXCEPTION 'SELFTEST_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    v_got := SQLERRM;
  END service_role_pays;
  IF v_seen IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'FAIL service_role_pays: could not switch role (current_user %, err %)', v_seen, v_got; END IF;
  IF v_got IS DISTINCT FROM 'SELFTEST_UNWIND' THEN RAISE EXCEPTION 'FAIL service_role_pays: got %', v_got; END IF;
  IF (v_res2->>'replay')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL service_role_pays: result %', v_res2; END IF;
  IF v_called THEN RAISE EXCEPTION 'FAIL service_role_pays: service_role inserted a payment row directly'; END IF;
  IF current_user = 'service_role' THEN RAISE EXCEPTION 'FAIL service_role_pays: role did not revert'; END IF;

  -- deny_anon / deny_authenticated: a real call and a real read under each role are refused. Variables survive the
  -- sub-block rollback; the role itself reverts with it. A failed role switch is reported, never counted as a pass.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    v_called := false; v_got := NULL; v_seen := NULL;
    <<deny_call>>
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', v_role);
      v_seen := current_user;
      PERFORM public.pay_hubtel_order_from_wallet('selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 0.01, v_source, v_desc);
      v_called := true;
    EXCEPTION WHEN insufficient_privilege THEN
      v_got := SQLERRM;
    END deny_call;
    IF v_seen IS DISTINCT FROM v_role THEN
      RAISE EXCEPTION 'FAIL deny_%: could not switch role (current_user %, err %)', v_role, v_seen, v_got;
    END IF;
    IF v_called OR v_got IS NULL OR v_got NOT LIKE 'permission denied for function%' THEN
      RAISE EXCEPTION 'FAIL deny_%: called=% err=%', v_role, v_called, v_got;
    END IF;

    v_called := false; v_got := NULL; v_seen := NULL;
    <<deny_read>>
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', v_role);
      v_seen := current_user;
      PERFORM 1 FROM public.hubtel_wallet_payments LIMIT 1;
      v_called := true;
    EXCEPTION WHEN insufficient_privilege THEN
      v_got := SQLERRM;
    END deny_read;
    IF v_seen IS DISTINCT FROM v_role THEN
      RAISE EXCEPTION 'FAIL deny_% read: could not switch role (current_user %, err %)', v_role, v_seen, v_got;
    END IF;
    IF v_called OR v_got IS NULL OR v_got NOT LIKE 'permission denied for table%' THEN
      RAISE EXCEPTION 'FAIL deny_% read: read=% err=%', v_role, v_called, v_got;
    END IF;
  END LOOP;
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'FAIL deny: role did not revert (%)', current_user;
  END IF;

  -- happy: one debit, one history row, one debited payment row ------------------------
  v_res := public.pay_hubtel_order_from_wallet(v_session, v_user, 'ussd_orders', v_order, 0.50, v_source, v_desc);
  v_paid := v_paid + 0.50;
  IF (v_res->>'replay')::boolean IS DISTINCT FROM false OR (v_res->>'payment_id') IS NULL THEN
    RAISE EXCEPTION 'FAIL happy: result %', v_res;
  END IF;
  IF (v_res->>'new_balance')::numeric <> v_bal0 - 0.50 THEN RAISE EXCEPTION 'FAIL happy: new_balance %', v_res->>'new_balance'; END IF;
  SELECT w.balance, COALESCE(w.total_spent, 0) INTO v_bal, v_spent FROM public.wallets w WHERE w.user_id = v_user;
  IF v_bal <> v_bal0 - 0.50 OR v_spent <> v_spent0 + 0.50 THEN RAISE EXCEPTION 'FAIL happy: wallet % / %', v_bal, v_spent; END IF;
  SELECT count(*) INTO v_n FROM public.transactions t
   WHERE t.user_id = v_user AND t.reference_id = v_order::text AND t.type = 'debit' AND t.source = v_source AND t.amount = 0.50
     AND t.balance_before = v_bal0 AND t.balance_after = v_bal0 - 0.50 AND t.description = v_desc AND t.status = 'completed';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL happy: % matching history rows', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.hubtel_wallet_payments p
   WHERE p.id = (v_res->>'payment_id')::uuid AND p.session_id = v_session AND p.order_table = 'ussd_orders' AND p.order_id = v_order
     AND p.user_id = v_user AND p.amount = 0.50 AND p.state = 'debited' AND p.review_reason IS NULL AND p.transaction_reference = v_order::text;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL happy: % matching payment rows', v_n; END IF;

  -- replay / replay_other_amount: same id, no second debit, even with another or an invalid amount ----------
  FOR v_ca IN SELECT unnest(ARRAY[0.50, 0.75, 0, -1, 1.999]::numeric[]) LOOP
    v_res2 := public.pay_hubtel_order_from_wallet(v_session, v_user, 'ussd_orders', v_order, v_ca, v_source, v_desc);
    IF (v_res2->>'replay')::boolean IS DISTINCT FROM true OR v_res2->'payment_id' <> v_res->'payment_id' THEN
      RAISE EXCEPTION 'FAIL replay_other_amount % : %', v_ca, v_res2;
    END IF;
    IF (v_res2->>'new_balance')::numeric <> v_bal0 - v_paid THEN RAISE EXCEPTION 'FAIL replay: new_balance %', v_res2->>'new_balance'; END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM public.transactions t WHERE t.user_id = v_user AND t.reference_id = v_order::text;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL replay: % history rows', v_n; END IF;
  SELECT w.balance INTO v_bal FROM public.wallets w WHERE w.user_id = v_user;
  IF v_bal <> v_bal0 - v_paid THEN RAISE EXCEPTION 'FAIL replay: balance %', v_bal; END IF;

  -- The refusals: the stated error, the wallet unchanged, no row for the case's session or order, no phone in the error.
  -- The carted session and order get their hubtel_transactions row first.
  v_sess2 := 'selftest-' || gen_random_uuid()::text;
  INSERT INTO public.hubtel_transactions (session_id, order_table, order_id, expected_amount)
  VALUES (v_sess2, 'ussd_orders', v_carted, 0.50);
  v_short := ceil((v_bal0 - v_paid) * 100) / 100 + 0.01;

  -- Columns: case, session, user, table, order, amount, source, description, expected error.
  FOR v_case, v_cs, v_cu, v_ct, v_co, v_ca, v_cso, v_cd, v_want IN
    SELECT * FROM (VALUES
      ('session_other_order',      v_session, v_user, 'ussd_orders',            v_order2, 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('session_other_table',      v_session, v_user, 'airtime_orders',         v_order,  0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('session_other_user',       v_session, v_other, 'ussd_orders',           v_order,  0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('other_session_same_order', 'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', v_order, 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('other_session_other_user', 'selftest-' || gen_random_uuid()::text, v_other, 'ussd_orders', v_order, 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('already_carted',           v_sess2, v_user, 'ussd_orders',              gen_random_uuid(), 0.50::numeric, v_source, v_desc, 'ALREADY_CARTED'),
      ('already_carted_other_session', 'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', v_carted, 0.50::numeric, v_source, v_desc, 'ALREADY_CARTED'),
      ('short_wallet',             'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), v_short, v_source, v_desc, 'INSUFFICIENT_FUNDS'),
      ('no_wallet',                'selftest-' || gen_random_uuid()::text, v_other, 'ussd_orders', gen_random_uuid(), 0.50::numeric, v_source, v_desc, 'INSUFFICIENT_FUNDS'),
      ('bad_table_shop',           'selftest-' || gen_random_uuid()::text, v_user, 'ussd_shop_orders', gen_random_uuid(), 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('bad_table_afa',            'selftest-' || gen_random_uuid()::text, v_user, 'ussd_afa_orders', gen_random_uuid(), 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('bad_table_case',           'selftest-' || gen_random_uuid()::text, v_user, 'USSD_ORDERS', gen_random_uuid(), 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('bad_table_null',           'selftest-' || gen_random_uuid()::text, v_user, NULL::text, gen_random_uuid(), 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('amount_zero',              'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 0::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('amount_negative',          'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), -0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('amount_three_dp',          'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 0.505::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('amount_null',              'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), NULL::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('amount_nan',               'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 'NaN'::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('amount_million',           'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 1000000::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('bad_source_other',         'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 0.50::numeric, 'data_purchase', v_desc, 'BAD_INPUT'),
      ('bad_source_case',          'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 0.50::numeric, 'AIRTIME_PURCHASE', v_desc, 'BAD_INPUT'),
      ('bad_source_null',          'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 0.50::numeric, NULL::text, v_desc, 'BAD_INPUT'),
      ('bad_session_null',         NULL::text, v_user, 'ussd_orders', gen_random_uuid(), 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('bad_session_blank',        '   ', v_user, 'ussd_orders', gen_random_uuid(), 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('bad_user_null',            'selftest-' || gen_random_uuid()::text, NULL::uuid, 'ussd_orders', gen_random_uuid(), 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('bad_order_null',           'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', NULL::uuid, 0.50::numeric, v_source, v_desc, 'BAD_INPUT'),
      ('bad_description_null',     'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 0.50::numeric, v_source, NULL::text, 'BAD_INPUT'),
      ('bad_description_blank',    'selftest-' || gen_random_uuid()::text, v_user, 'ussd_orders', gen_random_uuid(), 0.50::numeric, v_source, '  ', 'BAD_INPUT')
    ) AS t(c, s, u, tb, o, a, so, d, want)
  LOOP
    v_res2 := NULL;
    v_errdet := NULL;
    v_got := NULL;
    <<refusal>>
    BEGIN
      v_res2 := public.pay_hubtel_order_from_wallet(v_cs, v_cu, v_ct, v_co, v_ca, v_cso, v_cd);
      v_got := 'NO_ERROR';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_errdet = PG_EXCEPTION_DETAIL;
      v_got := SQLERRM;
    END refusal;
    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION 'FAIL %: expected %, got % (result %)', v_case, v_want, v_got, v_res2;
    END IF;
    IF v_errdet LIKE '%' || v_phone || '%' THEN RAISE EXCEPTION 'FAIL %: the phone is in DETAIL', v_case; END IF;
    SELECT w.balance INTO v_bal FROM public.wallets w WHERE w.user_id = v_user;
    IF v_bal <> v_bal0 - v_paid THEN RAISE EXCEPTION 'FAIL %: balance %', v_case, v_bal; END IF;
    -- The one payment made so far is the only row any refusal may find.
    SELECT count(*) INTO v_n FROM public.hubtel_wallet_payments p
     WHERE (p.session_id = v_cs OR p.order_id = v_co) AND p.id <> (v_res->>'payment_id')::uuid;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL %: % payment rows written', v_case, v_n; END IF;
    SELECT count(*) INTO v_n FROM public.transactions t WHERE t.reference_id = v_co::text AND v_co IS DISTINCT FROM v_order;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL %: % history rows written', v_case, v_n; END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM public.transactions t WHERE t.reference_id = v_order::text;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL refusals: % history rows for the paid order', v_n; END IF;

  -- every_table_and_source: each table with its source pays. A transactions_source_check that refuses a source fails here.
  FOR v_ct, v_cso IN
    SELECT * FROM (VALUES
      ('ussd_orders',            'ussd_data_purchase'),
      ('airtime_orders',         'airtime_purchase'),
      ('results_checker_orders', 'ussd_results_checker'),
      ('results_check_requests', 'results_check_request')
    ) AS t(tb, so)
  LOOP
    v_co := gen_random_uuid();
    v_res2 := public.pay_hubtel_order_from_wallet('selftest-' || gen_random_uuid()::text, v_user, v_ct, v_co, 0.01, v_cso, v_desc);
    v_paid := v_paid + 0.01;
    IF (v_res2->>'replay')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL every_table_and_source %: %', v_ct, v_res2; END IF;
    SELECT count(*) INTO v_n FROM public.transactions t WHERE t.reference_id = v_co::text AND t.source = v_cso AND t.type = 'debit';
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL every_table_and_source %: % history rows', v_ct, v_n; END IF;
  END LOOP;

  -- debit_already_recorded: a debit on the history key rolls the payment back and reports no data ---------------------
  v_co := gen_random_uuid();
  v_sess2 := 'selftest-' || gen_random_uuid()::text;
  INSERT INTO public.transactions (user_id, type, source, amount, description, reference_id, status)
  VALUES (v_user, 'debit', v_source, 0.01, v_desc, v_co::text, 'completed');
  v_got := NULL;
  v_errdet := NULL;
  <<debit_already_recorded>>
  BEGIN
    PERFORM public.pay_hubtel_order_from_wallet(v_sess2, v_user, 'ussd_orders', v_co, 0.50, v_source, v_desc);
    v_got := 'NO_ERROR';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_errdet = PG_EXCEPTION_DETAIL;
    v_got := SQLERRM;
  END debit_already_recorded;
  IF v_got IS DISTINCT FROM 'BAD_INPUT' THEN RAISE EXCEPTION 'FAIL debit_already_recorded: got %', v_got; END IF;
  IF v_errdet LIKE '%' || v_phone || '%' OR v_errdet LIKE '%' || v_co::text || '%' OR v_errdet LIKE '%' || v_user::text || '%' THEN
    RAISE EXCEPTION 'FAIL debit_already_recorded: row data in DETAIL';
  END IF;
  SELECT count(*) INTO v_n FROM public.hubtel_wallet_payments p WHERE p.session_id = v_sess2;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL debit_already_recorded: a payment row exists'; END IF;

  -- final_balance: the wallet moved by exactly what was paid --------------------------------------
  SELECT w.balance, COALESCE(w.total_spent, 0) INTO v_bal, v_spent FROM public.wallets w WHERE w.user_id = v_user;
  IF v_bal <> v_bal0 - v_paid OR v_spent <> v_spent0 + v_paid THEN
    RAISE EXCEPTION 'FAIL final_balance: % / % after paying %', v_bal, v_spent, v_paid;
  END IF;

  -- Always roll back. -------------------------------------------------------
  RAISE EXCEPTION 'SELFTEST_OK 0159: all scenarios passed; rolling back';
END $selftest$;
