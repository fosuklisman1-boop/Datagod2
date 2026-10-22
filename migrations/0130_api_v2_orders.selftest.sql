-- 0130_api_v2_orders.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0130_api_v2_orders.sql.
--
-- How to run (prod change protocol, dry-run step):
--   Send ONE request containing the body of 0130_api_v2_orders.sql WITHOUT
--   its BEGIN; / COMMIT; lines, followed by the DO block below, as a single
--   transaction. The DO block always ends with RAISE EXCEPTION, so every DDL
--   change, the throwaway api_v2_keys row, every wallet deduction, order and
--   transactions row is rolled back. The run PASSES when the error text
--   starts with 'SELFTEST_OK'; any 'FAIL: ...' or other error means it
--   failed. After the real apply, the DO block can also be run on its own.
--
-- What it cannot cover: true two-session races (identical concurrent calls,
-- two references racing one balance). Those rely on the wallet FOR UPDATE
-- lock + the re-check under the lock + the unique_violation backstop; see the
-- migration header. One session cannot reach the backstop handler.
--
-- Picks: the admin with the largest wallet balance (must be >= 2.00, so the
-- test never edits a balance directly), and one available package with a
-- plain numeric size. Uses test phones 0249990130 / 0249990131.

DO $$
DECLARE
  v_sig CONSTANT text := 'public.place_api_v2_order(uuid,uuid,uuid,text,numeric,numeric,text,text,text)';
  v_fail CONSTANT jsonb := '{"success": false, "error": "Order could not be placed"}'::jsonb;
  v_phone CONSTANT text := '0249990130';
  v_user uuid;
  v_key uuid;
  v_type text;
  v_pkg uuid;
  v_network text;
  v_volume numeric;
  v_b0 numeric;
  v_s0 numeric;
  v_b numeric;
  v_s numeric;
  v_ref text := 'selftest-' || gen_random_uuid()::text;
  v_ref2 text := 'selftest-' || gen_random_uuid()::text;
  v_r jsonb;
  v_order uuid;
  v_n int;
BEGIN
  -- Setup -------------------------------------------------------------------
  SELECT u.id, w.balance, COALESCE(w.total_spent, 0)
    INTO v_user, v_b0, v_s0
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  JOIN public.wallets w ON w.user_id = u.id
  WHERE u.role = 'admin' AND w.balance >= 2
  ORDER BY w.balance DESC
  LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'FAIL: setup: no admin with a wallet balance >= 2.00';
  END IF;

  SELECT p.id, p.network, p.size::numeric
    INTO v_pkg, v_network, v_volume
  FROM public.packages p
  WHERE p.is_available = true AND p.size ~ '^[0-9]+(\.[0-9]+)?$'
  ORDER BY p.network, p.size
  LIMIT 1;
  IF v_pkg IS NULL THEN
    RAISE EXCEPTION 'FAIL: setup: no available package with a numeric size';
  END IF;

  -- Throwaway active live key; pick a key_type the admin has no pending/active
  -- live key for (api_v2_keys_one_live_per_type).
  FOREACH v_type IN ARRAY ARRAY['standard', 'commission', 'sms'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.api_v2_keys
      WHERE user_id = v_user AND key_type = v_type AND environment = 'live'
        AND status IN ('pending', 'active')
    ) THEN
      INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix)
      VALUES (v_user, v_type, 'live', 'active', 'selftest 0130',
              'selftest-' || gen_random_uuid()::text, 'selftest')
      RETURNING id INTO v_key;
      EXIT;
    END IF;
  END LOOP;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'FAIL: setup: admin already has pending/active live keys of every type';
  END IF;

  -- Grants ------------------------------------------------------------------
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon can execute place_api_v2_order';
  END IF;
  IF has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated can execute place_api_v2_order';
  END IF;
  IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: service_role cannot execute place_api_v2_order';
  END IF;

  -- 1. First call charges once and creates one order ------------------------
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, 1.00, v_phone, v_ref, 'selftest 0130');
  IF NOT COALESCE((v_r->>'success')::boolean, false) OR (v_r->>'replayed')::boolean IS DISTINCT FROM false
     OR v_r->>'order_id' IS NULL OR v_r->>'created_at' IS NULL THEN
    RAISE EXCEPTION 'FAIL 1: first call result %', v_r;
  END IF;
  v_order := (v_r->>'order_id')::uuid;
  IF (v_r->>'new_balance')::numeric <> v_b0 - 1.00 THEN
    RAISE EXCEPTION 'FAIL 1: new_balance % expected %', v_r->>'new_balance', v_b0 - 1.00;
  END IF;
  SELECT balance, COALESCE(total_spent, 0) INTO v_b, v_s FROM public.wallets WHERE user_id = v_user;
  IF v_b <> v_b0 - 1.00 OR v_s <> v_s0 + 1.00 THEN
    RAISE EXCEPTION 'FAIL 1: wallet balance %/% total_spent %/%', v_b, v_b0 - 1.00, v_s, v_s0 + 1.00;
  END IF;
  SELECT count(*) INTO v_n FROM public.api_orders
  WHERE user_id = v_user AND api_reference = v_ref AND id = v_order
    AND api_key_id IS NULL AND api_v2_key_id = v_key AND status = 'pending'
    AND price = 1.00 AND package_id = v_pkg;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: expected 1 attributed pending order, got %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.transactions
  WHERE reference_id = v_order AND user_id = v_user AND type = 'debit' AND source = 'api_order'
    AND amount = 1.00 AND balance_before = v_b0 AND balance_after = v_b0 - 1.00 AND status = 'completed';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: expected 1 debit transaction, got %', v_n;
  END IF;

  -- 2. Identical second call replays, no second charge ----------------------
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, 1.00, v_phone, v_ref, 'selftest 0130');
  IF NOT COALESCE((v_r->>'success')::boolean, false) OR (v_r->>'replayed')::boolean IS DISTINCT FROM true
     OR (v_r->>'order_id')::uuid IS DISTINCT FROM v_order OR v_r->>'status' IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'FAIL 2: replay result %', v_r;
  END IF;
  -- Same content with a different network case / numeric scale still replays.
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, upper(v_network), v_volume + 0.000, 1.00, v_phone, v_ref, 'x');
  IF (v_r->>'replayed')::boolean IS DISTINCT FROM true OR (v_r->>'order_id')::uuid IS DISTINCT FROM v_order THEN
    RAISE EXCEPTION 'FAIL 2: case-insensitive replay result %', v_r;
  END IF;
  SELECT balance INTO v_b FROM public.wallets WHERE user_id = v_user;
  IF v_b <> v_b0 - 1.00 THEN
    RAISE EXCEPTION 'FAIL 2: replay moved money, balance % expected %', v_b, v_b0 - 1.00;
  END IF;
  SELECT count(*) INTO v_n FROM public.api_orders WHERE user_id = v_user AND api_reference = v_ref;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 2: % orders for the reference', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.transactions WHERE reference_id = v_order;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 2: % transactions for the order', v_n;
  END IF;

  -- 3. Same reference, different recipient / volume -> REFERENCE_REUSED -----
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, 1.00, '0249990131', v_ref, 'selftest 0130');
  IF COALESCE((v_r->>'success')::boolean, true) OR v_r->>'code' IS DISTINCT FROM 'REFERENCE_REUSED'
     OR v_r->>'error' IS DISTINCT FROM 'Reference reused with a different order' THEN
    RAISE EXCEPTION 'FAIL 3: different recipient result %', v_r;
  END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume + 1, 1.00, v_phone, v_ref, 'selftest 0130');
  IF v_r->>'code' IS DISTINCT FROM 'REFERENCE_REUSED' THEN
    RAISE EXCEPTION 'FAIL 3: different volume result %', v_r;
  END IF;
  SELECT balance INTO v_b FROM public.wallets WHERE user_id = v_user;
  IF v_b <> v_b0 - 1.00 THEN
    RAISE EXCEPTION 'FAIL 3: reuse moved money, balance %', v_b;
  END IF;

  -- 4. Over balance -> Insufficient balance, nothing changes ----------------
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_b0 + 1000, v_phone, v_ref2, 'selftest 0130');
  IF COALESCE((v_r->>'success')::boolean, true) OR v_r->>'error' IS DISTINCT FROM 'Insufficient balance'
     OR (v_r->>'required')::numeric <> v_b0 + 1000 OR (v_r->>'balance')::numeric <> v_b0 - 1.00 THEN
    RAISE EXCEPTION 'FAIL 4: over-balance result %', v_r;
  END IF;
  SELECT balance, COALESCE(total_spent, 0) INTO v_b, v_s FROM public.wallets WHERE user_id = v_user;
  IF v_b <> v_b0 - 1.00 OR v_s <> v_s0 + 1.00 THEN
    RAISE EXCEPTION 'FAIL 4: wallet changed, balance % total_spent %', v_b, v_s;
  END IF;
  SELECT count(*) INTO v_n FROM public.api_orders WHERE user_id = v_user AND api_reference = v_ref2;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL 4: order row created on insufficient balance';
  END IF;

  -- 5. Bad price / volume / phone / key -> generic failure, nothing changes -
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, 0, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: price 0 result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, -5, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: negative price result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, 'NaN'::numeric, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: NaN price result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, NULL, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: NULL price result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, 0, 1.00, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: volume 0 result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, 1.00, '  ', v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: blank phone result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, 1.00, v_phone, '', 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: empty reference result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, gen_random_uuid(), v_pkg, v_network, v_volume, 1.00, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: unknown key result %', v_r; END IF;
  SELECT balance, COALESCE(total_spent, 0) INTO v_b, v_s FROM public.wallets WHERE user_id = v_user;
  IF v_b <> v_b0 - 1.00 OR v_s <> v_s0 + 1.00 THEN
    RAISE EXCEPTION 'FAIL 5: wallet changed, balance % total_spent %', v_b, v_s;
  END IF;
  SELECT count(*) INTO v_n FROM public.api_orders WHERE user_id = v_user AND api_reference = v_ref2;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL 5: order row created for a rejected call';
  END IF;

  -- 6. CHECK constraints: a row with no key is refused ----------------------
  BEGIN
    INSERT INTO public.api_orders (user_id, api_key_id, api_v2_key_id, network, volume_gb, price,
                                   recipient_phone, api_reference, status)
    VALUES (v_user, NULL, NULL, v_network, v_volume, 1.00, v_phone, v_ref2, 'pending');
    RAISE EXCEPTION 'FAIL 6: api_orders accepted a row with no key';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.sandbox_orders (user_id, api_key_id, api_v2_key_id, action, reference,
                                       request, response, price, resolves_at)
    VALUES (v_user, NULL, NULL, 'data_order', v_ref2, '{}'::jsonb, '{}'::jsonb, 1.00, now());
    RAISE EXCEPTION 'FAIL 6: sandbox_orders accepted a row with no key';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  -- A v2-only sandbox row is accepted (FK to api_v2_keys).
  INSERT INTO public.sandbox_orders (user_id, api_key_id, api_v2_key_id, action, reference,
                                     request, response, price, resolves_at)
  VALUES (v_user, NULL, v_key, 'data_order', v_ref2, '{}'::jsonb, '{}'::jsonb, 1.00, now());

  -- Always roll back. -------------------------------------------------------
  RAISE EXCEPTION 'SELFTEST_OK 0130: all scenarios passed (package % %GB); rolling back', v_network, v_volume;
END $$;
