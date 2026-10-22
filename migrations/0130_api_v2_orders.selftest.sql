-- 0130_api_v2_orders.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0130_api_v2_orders.sql.
--
-- How to run (prod change protocol, dry-run step):
--   Send ONE request containing 0130_api_v2_orders.sql with ONLY its final
--   `COMMIT;` line removed (keep `BEGIN;` and both SET LOCALs), followed by
--   the DO block below. The DO block always ends with RAISE EXCEPTION, which
--   aborts the explicit transaction whatever the client does, so every DDL
--   change, the throwaway api_v2_keys rows, every wallet deduction, order and
--   transactions row is rolled back. If the client keeps the session open
--   afterwards, send `ROLLBACK;`. The run PASSES when the error text starts
--   with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
--   After the real apply, the DO block can also be run alone inside
--   `BEGIN; ... ` (no COMMIT).
--
-- What it cannot cover: true two-session races (identical concurrent calls,
-- two references racing one balance, a revoke racing a placement). Those
-- rely on the wallet FOR UPDATE lock + the re-check under the lock + the
-- unique_violation backstop + the key FOR SHARE lock; see the migration
-- header. One session cannot reach the backstop handler.
--
-- Picks: the cheapest available package with a numeric size and a valid
-- 2-decimal price, the admin with the largest wallet balance (must cover that
-- price, so the test never edits a balance directly), another auth user
-- (for the not-your-key case) and, if one exists, a user with no wallet row.
-- Uses test phones 0249990130 / 0249990131.
--
-- Types: transactions.reference_id is TEXT (compare with v_order::text);
-- packages.size is TEXT (regex-guarded before casting); api_orders.id and
-- api_v2_keys.id are uuid; prices/balances are numeric.

DO $$
DECLARE
  v_sig CONSTANT text := 'public.place_api_v2_order(uuid,uuid,uuid,text,numeric,numeric,text,text,text)';
  v_fail CONSTANT jsonb := '{"success": false, "error": "Order could not be placed"}'::jsonb;
  v_phone CONSTANT text := '0249990130';
  v_user uuid;
  v_other uuid;
  v_nowallet uuid;
  v_key uuid;
  v_nowallet_key uuid;
  v_type text;
  v_pkg uuid;
  v_network text;
  v_volume numeric;
  v_price numeric;
  v_dealer numeric;
  v_bad_price numeric;
  v_b0 numeric;
  v_s0 numeric;
  v_b numeric;
  v_s numeric;
  v_ref text := 'selftest-' || gen_random_uuid()::text;
  v_ref2 text := 'selftest-' || gen_random_uuid()::text;
  v_r jsonb;
  v_order uuid;
  v_n int;
  v_bad numeric;
BEGIN
  -- Setup -------------------------------------------------------------------
  SELECT p.id, p.network, p.size::numeric, p.price, p.dealer_price
    INTO v_pkg, v_network, v_volume, v_price, v_dealer
  FROM public.packages p
  WHERE p.is_available = true
    AND p.size ~ '^[0-9]+(\.[0-9]+)?$'
    AND p.price >= 0.01 AND p.price = round(p.price, 2)
  ORDER BY p.price, p.network, p.size
  LIMIT 1;
  IF v_pkg IS NULL THEN
    RAISE EXCEPTION 'FAIL: setup: no available package with a numeric size and a valid price';
  END IF;
  v_bad_price := greatest(v_price, COALESCE(v_dealer, 0)) + 0.01;

  SELECT u.id, w.balance, COALESCE(w.total_spent, 0)
    INTO v_user, v_b0, v_s0
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  JOIN public.wallets w ON w.user_id = u.id
  WHERE u.role = 'admin' AND w.balance >= v_price
  ORDER BY w.balance DESC
  LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'FAIL: setup: no admin with a wallet balance >= % (package price)', v_price;
  END IF;

  SELECT au.id INTO v_other FROM auth.users au WHERE au.id <> v_user LIMIT 1;
  IF v_other IS NULL THEN
    RAISE EXCEPTION 'FAIL: setup: no second auth user';
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
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, v_phone, v_ref, 'selftest 0130');
  IF NOT COALESCE((v_r->>'success')::boolean, false) OR (v_r->>'replayed')::boolean IS DISTINCT FROM false
     OR v_r->>'order_id' IS NULL OR v_r->>'created_at' IS NULL THEN
    RAISE EXCEPTION 'FAIL 1: first call result %', v_r;
  END IF;
  v_order := (v_r->>'order_id')::uuid;
  IF (v_r->>'new_balance')::numeric <> v_b0 - v_price THEN
    RAISE EXCEPTION 'FAIL 1: new_balance % expected %', v_r->>'new_balance', v_b0 - v_price;
  END IF;
  SELECT balance, COALESCE(total_spent, 0) INTO v_b, v_s FROM public.wallets WHERE user_id = v_user;
  IF v_b <> v_b0 - v_price OR v_s <> v_s0 + v_price THEN
    RAISE EXCEPTION 'FAIL 1: wallet balance %/% total_spent %/%', v_b, v_b0 - v_price, v_s, v_s0 + v_price;
  END IF;
  SELECT count(*) INTO v_n FROM public.api_orders
  WHERE user_id = v_user AND api_reference = v_ref AND id = v_order
    AND api_key_id IS NULL AND api_v2_key_id = v_key AND status = 'pending'
    AND price = v_price AND package_id = v_pkg;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: expected 1 attributed pending order, got %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.transactions
  WHERE reference_id = v_order::text AND user_id = v_user AND type = 'debit' AND source = 'api_order'
    AND amount = v_price AND balance_before = v_b0 AND balance_after = v_b0 - v_price
    AND status = 'completed';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: expected 1 debit transaction, got %', v_n;
  END IF;

  -- 2. Identical second call replays, no second charge ----------------------
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, v_phone, v_ref, 'selftest 0130');
  IF NOT COALESCE((v_r->>'success')::boolean, false) OR (v_r->>'replayed')::boolean IS DISTINCT FROM true
     OR (v_r->>'order_id')::uuid IS DISTINCT FROM v_order OR v_r->>'status' IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'FAIL 2: replay result %', v_r;
  END IF;
  -- Same content with a different network case / numeric scale still replays.
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, upper(v_network), v_volume + 0.000, v_price, v_phone, v_ref, 'x');
  IF (v_r->>'replayed')::boolean IS DISTINCT FROM true OR (v_r->>'order_id')::uuid IS DISTINCT FROM v_order THEN
    RAISE EXCEPTION 'FAIL 2: case-insensitive replay result %', v_r;
  END IF;
  SELECT balance INTO v_b FROM public.wallets WHERE user_id = v_user;
  IF v_b <> v_b0 - v_price THEN
    RAISE EXCEPTION 'FAIL 2: replay moved money, balance % expected %', v_b, v_b0 - v_price;
  END IF;
  SELECT count(*) INTO v_n FROM public.api_orders WHERE user_id = v_user AND api_reference = v_ref;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 2: % orders for the reference', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.transactions WHERE reference_id = v_order::text;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL 2: % transactions for the order', v_n;
  END IF;

  -- 3. Same reference, different recipient / volume -> REFERENCE_REUSED -----
  --    (the reference lookup runs before the package check, so this holds
  --    even when no package of the other volume exists)
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, '0249990131', v_ref, 'selftest 0130');
  IF COALESCE((v_r->>'success')::boolean, true) OR v_r->>'code' IS DISTINCT FROM 'REFERENCE_REUSED'
     OR v_r->>'error' IS DISTINCT FROM 'Reference reused with a different order' THEN
    RAISE EXCEPTION 'FAIL 3: different recipient result %', v_r;
  END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume + 1, v_price, v_phone, v_ref, 'selftest 0130');
  IF v_r->>'code' IS DISTINCT FROM 'REFERENCE_REUSED' THEN
    RAISE EXCEPTION 'FAIL 3: different volume result %', v_r;
  END IF;
  SELECT balance INTO v_b FROM public.wallets WHERE user_id = v_user;
  IF v_b <> v_b0 - v_price THEN
    RAISE EXCEPTION 'FAIL 3: reuse moved money, balance %', v_b;
  END IF;

  -- 4. Over balance -> Insufficient balance, nothing changes ----------------
  --    The price must be one of the package's tiers, and the test does not
  --    edit balances, so it temporarily raises this package's price above the
  --    balance and restores it after (also rolled back at the end).
  UPDATE public.packages SET price = v_b0 + 1000 WHERE id = v_pkg;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_b0 + 1000, v_phone, v_ref2, 'selftest 0130');
  IF COALESCE((v_r->>'success')::boolean, true) OR v_r->>'error' IS DISTINCT FROM 'Insufficient balance'
     OR (v_r->>'required')::numeric <> v_b0 + 1000 OR (v_r->>'balance')::numeric <> v_b0 - v_price THEN
    RAISE EXCEPTION 'FAIL 4: over-balance result %', v_r;
  END IF;
  UPDATE public.packages SET price = v_price WHERE id = v_pkg;
  SELECT balance, COALESCE(total_spent, 0) INTO v_b, v_s FROM public.wallets WHERE user_id = v_user;
  IF v_b <> v_b0 - v_price OR v_s <> v_s0 + v_price THEN
    RAISE EXCEPTION 'FAIL 4: wallet changed, balance % total_spent %', v_b, v_s;
  END IF;
  SELECT count(*) INTO v_n FROM public.api_orders WHERE user_id = v_user AND api_reference = v_ref2;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL 4: order row created on insufficient balance';
  END IF;

  -- 5. Bad price / volume / phone / reference -> generic failure ------------
  FOREACH v_bad IN ARRAY ARRAY[0, -5, 0.004, 4.555, 'NaN'::numeric, 'Infinity'::numeric]::numeric[] LOOP
    v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_bad, v_phone, v_ref2, 'selftest 0130');
    IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: price % result %', v_bad, v_r; END IF;
  END LOOP;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, NULL, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: NULL price result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, 0, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: volume 0 result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, '  ', v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: blank phone result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, v_phone, '', 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 5: empty reference result %', v_r; END IF;

  -- 6. Package defence in depth -> generic failure --------------------------
  v_r := public.place_api_v2_order(v_user, v_key, NULL, v_network, v_volume, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 6: NULL package result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, gen_random_uuid(), v_network, v_volume, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 6: unknown package result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, 'selftest-network', v_volume, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 6: wrong network result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume + 1000, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 6: wrong volume result %', v_r; END IF;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_bad_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 6: price % matches no tier, result %', v_bad_price, v_r; END IF;
  UPDATE public.packages SET is_available = false WHERE id = v_pkg;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 6: unavailable package result %', v_r; END IF;
  -- A replay still answers when the package was disabled after the order.
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, v_phone, v_ref, 'selftest 0130');
  IF (v_r->>'replayed')::boolean IS DISTINCT FROM true OR (v_r->>'order_id')::uuid IS DISTINCT FROM v_order THEN
    RAISE EXCEPTION 'FAIL 6: replay on disabled package result %', v_r;
  END IF;
  UPDATE public.packages SET is_available = true WHERE id = v_pkg;
  -- The dealer tier is accepted when > 0 (only if it differs from price).
  IF v_dealer > 0 AND v_dealer <> v_price AND v_dealer = round(v_dealer, 2) AND v_b0 - v_price >= v_dealer THEN
    v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_dealer, v_phone,
                                     'selftest-' || gen_random_uuid()::text, 'selftest 0130');
    IF NOT COALESCE((v_r->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'FAIL 6: dealer tier % refused, result %', v_dealer, v_r;
    END IF;
    v_b0 := v_b0 - v_dealer;  -- keep later balance assertions consistent
    v_s0 := v_s0 + v_dealer;
  END IF;

  -- 7. Authorization -> generic failure --------------------------------------
  v_r := public.place_api_v2_order(v_user, gen_random_uuid(), v_pkg, v_network, v_volume, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 7: unknown key result %', v_r; END IF;
  -- Another user presenting this admin's key.
  v_r := public.place_api_v2_order(v_other, v_key, v_pkg, v_network, v_volume, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 7: another user''s key result %', v_r; END IF;
  -- Same key flipped to test / pending / revoked (restored after).
  UPDATE public.api_v2_keys SET environment = 'test' WHERE id = v_key;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 7: test key result %', v_r; END IF;
  UPDATE public.api_v2_keys SET environment = 'live', status = 'pending' WHERE id = v_key;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 7: pending key result %', v_r; END IF;
  UPDATE public.api_v2_keys SET status = 'revoked', revoked_at = now() WHERE id = v_key;
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, v_phone, v_ref2, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 7: revoked key result %', v_r; END IF;
  -- A revoked key also gets no replay of an existing order.
  v_r := public.place_api_v2_order(v_user, v_key, v_pkg, v_network, v_volume, v_price, v_phone, v_ref, 'selftest 0130');
  IF v_r IS DISTINCT FROM v_fail THEN RAISE EXCEPTION 'FAIL 7: revoked key replay result %', v_r; END IF;
  UPDATE public.api_v2_keys SET status = 'active', revoked_at = NULL WHERE id = v_key;

  -- None of sections 5-7 moved money or created rows.
  SELECT balance, COALESCE(total_spent, 0) INTO v_b, v_s FROM public.wallets WHERE user_id = v_user;
  IF v_b <> v_b0 - v_price OR v_s <> v_s0 + v_price THEN
    RAISE EXCEPTION 'FAIL 5-7: wallet changed, balance % total_spent %', v_b, v_s;
  END IF;
  SELECT count(*) INTO v_n FROM public.api_orders WHERE user_id IN (v_user, v_other) AND api_reference = v_ref2;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL 5-7: order row created for a rejected call';
  END IF;

  -- 8. Wallet not found (only if some auth user has no wallet row) -----------
  SELECT u.id INTO v_nowallet
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  WHERE NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM public.api_v2_keys k
                    WHERE k.user_id = u.id AND k.key_type = 'standard' AND k.environment = 'live'
                      AND k.status IN ('pending', 'active'))
  LIMIT 1;
  IF v_nowallet IS NULL THEN
    RAISE NOTICE 'SKIP 8: every user has a wallet; Wallet-not-found not exercised';
  ELSE
    INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix)
    VALUES (v_nowallet, 'standard', 'live', 'active', 'selftest 0130',
            'selftest-' || gen_random_uuid()::text, 'selftest')
    RETURNING id INTO v_nowallet_key;
    v_r := public.place_api_v2_order(v_nowallet, v_nowallet_key, v_pkg, v_network, v_volume, v_price, v_phone, v_ref2, 'selftest 0130');
    IF v_r IS DISTINCT FROM '{"success": false, "error": "Wallet not found"}'::jsonb THEN
      RAISE EXCEPTION 'FAIL 8: no-wallet result %', v_r;
    END IF;
  END IF;

  -- 9. CHECK constraints: a row with no key is refused ----------------------
  BEGIN
    INSERT INTO public.api_orders (user_id, api_key_id, api_v2_key_id, network, volume_gb, price,
                                   recipient_phone, api_reference, status)
    VALUES (v_user, NULL, NULL, v_network, v_volume, v_price, v_phone, v_ref2, 'pending');
    RAISE EXCEPTION 'FAIL 9: api_orders accepted a row with no key';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.sandbox_orders (user_id, api_key_id, api_v2_key_id, action, reference,
                                       request, response, price, resolves_at)
    VALUES (v_user, NULL, NULL, 'data_order', v_ref2, '{}'::jsonb, '{}'::jsonb, v_price, now());
    RAISE EXCEPTION 'FAIL 9: sandbox_orders accepted a row with no key';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  -- A v2-only sandbox row is accepted (FK to api_v2_keys).
  INSERT INTO public.sandbox_orders (user_id, api_key_id, api_v2_key_id, action, reference,
                                     request, response, price, resolves_at)
  VALUES (v_user, NULL, v_key, 'data_order', v_ref2, '{}'::jsonb, '{}'::jsonb, v_price, now());

  -- Always roll back. -------------------------------------------------------
  RAISE EXCEPTION 'SELFTEST_OK 0130: all scenarios passed (package % %GB at %); rolling back',
    v_network, v_volume, v_price;
END $$;
