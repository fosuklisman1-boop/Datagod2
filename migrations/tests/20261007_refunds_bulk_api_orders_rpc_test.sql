-- Rollback-safe test for the orders / api_orders refund extension (20261007_refunds_bulk_api_orders.sql).
-- Single transaction; always ROLLBACK. Any failed ASSERT aborts the run.
-- Fixtures: one existing user with a wallet (balance forced to a known value), one existing package and (if any)
-- one existing API key. Column lists come from migrations/20260327_create_api_orders.sql, docs/database/SUPABASE_SETUP.md
-- (orders) and app/api/orders/purchase/route.ts (the live INSERT). If your live schema has an extra NOT NULL column
-- without a default on either table, add it to mk_orders_row / mk_api_row below.
-- NOTE: this file was written without database access and has NOT been executed.
BEGIN;

CREATE FUNCTION pg_temp.set_wallet(p_user uuid, p_balance numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallets SET balance = p_balance WHERE user_id = p_user;
  IF NOT FOUND THEN INSERT INTO wallets (user_id, balance) VALUES (p_user, p_balance); END IF;
END $$;

CREATE FUNCTION pg_temp.mk_orders_row(p_user uuid, p_pkg uuid, p_status text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  INSERT INTO orders (user_id, package_id, network, size, price, status, phone_number, order_code)
    VALUES (p_user, p_pkg, 'MTN', '1', 5, p_status, '0240000001', 'TEST-' || gen_random_uuid()::text)
    RETURNING id INTO v;
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.mk_api_row(p_user uuid, p_key uuid, p_status text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  INSERT INTO api_orders (user_id, api_key_id, network, volume_gb, price, recipient_phone, api_reference, status)
    VALUES (p_user, p_key, 'MTN', 1, 5, '0240000002', 'TEST-' || gen_random_uuid()::text, p_status)
    RETURNING id INTO v;
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.st(p_table text, p_id uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT status::text FROM %I WHERE id = $1', p_table) INTO v USING p_id;
  RETURN v;
END $$;

DO $$
DECLARE
  v_user uuid; v_pkg uuid; v_key uuid;
  v_o uuid; v_a uuid; v_o2 uuid; v_a2 uuid; v_x uuid;
  v_res jsonb; v_rid uuid; v_rid2 uuid; v_err text; v_w numeric; v_u uuid; v_n int;
BEGIN
  SELECT user_id INTO v_user FROM wallets ORDER BY user_id LIMIT 1;
  ASSERT v_user IS NOT NULL, 'need at least one wallet to run this test';
  SELECT id INTO v_pkg FROM packages ORDER BY id LIMIT 1;
  ASSERT v_pkg IS NOT NULL, 'need at least one package to run this test';
  SELECT id INTO v_key FROM user_api_keys ORDER BY id LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION 'test needs at least one user_api_keys row'; END IF;

  PERFORM pg_temp.set_wallet(v_user, 50);

  -- (1) orders: pending -> reserve -> refunding, no clawbacks, prev_status recorded
  v_o := pg_temp.mk_orders_row(v_user, v_pkg, 'pending');
  v_res := reserve_order_refund('orders', v_o, 'wallet', 5, 0, 5, NULL, v_user, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  ASSERT v_res->'clawbacks' = '[]'::jsonb, 'orders: no clawbacks';
  ASSERT pg_temp.st('orders', v_o) = 'refunding', 'orders: status refunding';
  ASSERT (SELECT prev_status FROM order_refunds WHERE id = v_rid) = 'pending', 'orders: prev_status recorded';
  ASSERT (SELECT order_table FROM order_refunds WHERE id = v_rid) = 'orders', 'orders: ledger table';
  SELECT balance INTO v_w FROM wallets WHERE user_id = v_user;
  ASSERT v_w = 50, 'orders: reserve does not touch any wallet (the buyer is credited by the gateway, not the RPC)';

  -- (2) second reserve on the same order is rejected
  BEGIN
    PERFORM reserve_order_refund('orders', v_o, 'wallet', 5, 0, 5, NULL, v_user, NULL);
    ASSERT false, 'second reserve must fail';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err IN ('ORDER_NOT_PENDING','ALREADY_REFUNDED'), 'got: ' || v_err;
  END;

  -- (3) guard: a late writer cannot move a refunding order; the attempt is logged
  UPDATE orders SET status = 'completed' WHERE id = v_o;
  ASSERT pg_temp.st('orders', v_o) = 'refunding', 'orders: guard keeps refunding';
  ASSERT jsonb_array_length((SELECT late_events FROM order_refunds WHERE id = v_rid)) = 1, 'orders: late event recorded';

  -- (4) fail restores the order to pending; second call is a no-op
  ASSERT fail_order_refund(v_rid, 'gateway said no') = 'failed', 'orders: fail returns failed';
  ASSERT fail_order_refund(v_rid, 'again') = 'failed', 'orders: repeat fail returns failed';
  ASSERT pg_temp.st('orders', v_o) = 'pending', 'orders: back to pending';

  -- (5) a fresh refund may be created after a failed one, and complete settles it
  v_res := reserve_order_refund('orders', v_o, 'wallet', 5, 0, 5, NULL, v_user, NULL);
  v_rid2 := (v_res->>'refund_id')::uuid;
  PERFORM mark_refund_processing(v_rid2, 'GW1', 'sent');
  ASSERT complete_order_refund(v_rid2, 'REFUND_X') = 'completed', 'orders: complete returns completed';
  ASSERT pg_temp.st('orders', v_o) = 'refunded', 'orders: refunded';
  UPDATE orders SET status = 'pending' WHERE id = v_o;
  ASSERT pg_temp.st('orders', v_o) = 'refunded', 'orders: guard keeps refunded';
  ASSERT fail_order_refund(v_rid2, 'late fail') = 'completed', 'orders: fail after complete is a no-op';
  ASSERT pg_temp.st('orders', v_o) = 'refunded', 'orders: stays refunded';
  ASSERT complete_order_refund(v_rid2, 'AGAIN') = 'completed', 'orders: repeat complete returns completed';

  -- (6) orders: only 'pending' is refundable
  v_o2 := pg_temp.mk_orders_row(v_user, v_pkg, 'processing');
  BEGIN
    PERFORM reserve_order_refund('orders', v_o2, 'wallet', 5, 0, 5, NULL, v_user, NULL);
    ASSERT false, 'processing orders row must not be refundable';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'ORDER_NOT_PENDING', 'got: ' || v_err;
  END;
  v_x := pg_temp.mk_orders_row(v_user, v_pkg, 'held_registration');
  BEGIN
    PERFORM reserve_order_refund('orders', v_x, 'wallet', 5, 0, 5, NULL, v_user, NULL);
    ASSERT false, 'held_registration is only refundable on api_orders';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'ORDER_NOT_PENDING', 'got: ' || v_err;
  END;

  -- (7) api_orders: held_registration is refundable and is RESTORED (not pending) on failure
  v_a := pg_temp.mk_api_row(v_user, v_key, 'held_registration');
  v_res := reserve_order_refund('api_orders', v_a, 'wallet', 5, 0, 5, NULL, v_user, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  ASSERT v_res->'clawbacks' = '[]'::jsonb, 'api: no clawbacks';
  ASSERT pg_temp.st('api_orders', v_a) = 'refunding', 'api: status refunding';
  ASSERT (SELECT prev_status FROM order_refunds WHERE id = v_rid) = 'held_registration', 'api: prev_status recorded';
  UPDATE api_orders SET status = 'completed' WHERE id = v_a;
  ASSERT pg_temp.st('api_orders', v_a) = 'refunding', 'api: guard keeps refunding';
  ASSERT jsonb_array_length((SELECT late_events FROM order_refunds WHERE id = v_rid)) = 1, 'api: late event recorded';
  ASSERT fail_order_refund(v_rid, 'cancelled') = 'failed', 'api: fail returns failed';
  ASSERT pg_temp.st('api_orders', v_a) = 'held_registration', 'api: restored to held_registration';

  -- (8) api_orders: pending is refundable and returns to pending; complete -> refunded
  v_a2 := pg_temp.mk_api_row(v_user, v_key, 'pending');
  v_res := reserve_order_refund('api_orders', v_a2, 'wallet', 5, 0, 5, NULL, v_user, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  ASSERT (SELECT prev_status FROM order_refunds WHERE id = v_rid) = 'pending', 'api: prev_status pending';
  ASSERT fail_order_refund(v_rid, 'cancelled') = 'failed', 'api: fail returns failed (pending)';
  ASSERT pg_temp.st('api_orders', v_a2) = 'pending', 'api: restored to pending';
  v_res := reserve_order_refund('api_orders', v_a2, 'wallet', 5, 0, 5, NULL, v_user, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  ASSERT complete_order_refund(v_rid, 'REFUND_Y') = 'completed', 'api: complete returns completed';
  ASSERT pg_temp.st('api_orders', v_a2) = 'refunded', 'api: refunded';

  -- (9) api_orders: processing is not refundable
  v_x := pg_temp.mk_api_row(v_user, v_key, 'processing');
  BEGIN
    PERFORM reserve_order_refund('api_orders', v_x, 'wallet', 5, 0, 5, NULL, v_user, NULL);
    ASSERT false, 'processing api_orders row must not be refundable';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'ORDER_NOT_PENDING', 'got: ' || v_err;
  END;

  -- (10) dispatch claim is refused while a refund is active (same advisory lock, same ledger)
  v_x := pg_temp.mk_orders_row(v_user, v_pkg, 'pending');
  v_res := reserve_order_refund('orders', v_x, 'wallet', 5, 0, 5, NULL, v_user, NULL);
  ASSERT claim_order_dispatch(v_x) = false, 'dispatch refused for an order being refunded';
  PERFORM fail_order_refund((v_res->>'refund_id')::uuid, 'cleanup');
  ASSERT claim_order_dispatch(v_x) = true, 'dispatch allowed again after the refund failed';
  BEGIN
    PERFORM reserve_order_refund('orders', v_x, 'wallet', 5, 0, 5, NULL, v_user, NULL);
    ASSERT false, 'reserve must fail while a dispatch is claimed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'DISPATCH_ACTIVE', 'got: ' || v_err;
  END;

  -- (11) validation errors
  BEGIN
    PERFORM reserve_order_refund('bogus_table', v_o, 'wallet', 5, 0, 5, NULL, NULL, NULL);
    ASSERT false, 'BAD_TABLE expected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'BAD_TABLE', 'got: ' || v_err;
  END;
  BEGIN
    PERFORM reserve_order_refund('api_orders', v_a, 'wallet', 5, 0, 6, NULL, NULL, NULL);
    ASSERT false, 'BAD_AMOUNT (> paid) expected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'BAD_AMOUNT', 'got: ' || v_err;
  END;
  BEGIN
    PERFORM reserve_order_refund('orders', gen_random_uuid(), 'wallet', 5, 0, 5, NULL, NULL, NULL);
    ASSERT false, 'ORDER_NOT_FOUND expected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'ORDER_NOT_FOUND', 'got: ' || v_err;
  END;

  -- (12) the ledger accepts the new tables only through the widened CHECK
  BEGIN
    INSERT INTO order_refunds (order_table, order_id, gateway, paid_amount, amount)
      VALUES ('not_a_table', gen_random_uuid(), 'wallet', 5, 5);
    ASSERT false, 'CHECK must still reject unknown tables';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- (13) regression: an ORIGINAL table still behaves (ussd_orders, no shop profits)
  INSERT INTO ussd_orders (dialing_phone, recipient_phone, network, paystack_provider, amount, order_status, payment_status)
    VALUES ('0240000003', '0240000003', 'MTN', 'mtn', 12, 'pending', 'completed') RETURNING id INTO v_u;
  v_res := reserve_order_refund('ussd_orders', v_u, 'wallet', 12, 0, 12, '0240000003', NULL, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  ASSERT v_res->'clawbacks' = '[]'::jsonb, 'ussd: no profits => no clawbacks';
  ASSERT (SELECT order_status::text FROM ussd_orders WHERE id = v_u) = 'refunding', 'ussd: refunding';
  ASSERT (SELECT prev_status FROM order_refunds WHERE id = v_rid) = 'pending', 'ussd: prev_status pending';
  ASSERT fail_order_refund(v_rid, 'cleanup') = 'failed', 'ussd: fail returns failed';
  ASSERT (SELECT order_status::text FROM ussd_orders WHERE id = v_u) = 'pending', 'ussd: restored to pending';
  UPDATE ussd_orders SET payment_status = 'pending' WHERE id = v_u;
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', v_u, 'wallet', 12, 0, 12, NULL, NULL, NULL);
    ASSERT false, 'unpaid ussd order must not be refundable';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'ORDER_NOT_PENDING', 'got: ' || v_err;
  END;

  -- (14) p_expected_attempts: mismatch => DISPATCH_ACTIVE, matching value succeeds (new table)
  v_x := pg_temp.mk_orders_row(v_user, v_pkg, 'pending');
  ASSERT claim_order_dispatch(v_x) = true, 'claim for the attempts test';
  PERFORM record_dispatch_outcome(v_x, 'failed');
  BEGIN
    PERFORM reserve_order_refund('orders', v_x, 'wallet', 5, 0, 5, NULL, v_user, NULL, 0);
    ASSERT false, 'wrong p_expected_attempts must fail';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'DISPATCH_ACTIVE', 'got: ' || v_err;
  END;
  v_res := reserve_order_refund('orders', v_x, 'wallet', 5, 0, 5, NULL, v_user, NULL,
    (SELECT attempts FROM order_dispatch_claims WHERE order_id = v_x));
  ASSERT v_res->>'refund_id' IS NOT NULL, 'matching p_expected_attempts succeeds';
  v_rid := (v_res->>'refund_id')::uuid;

  -- (15) NULL prev_status (a refund reserved before this migration) restores 'pending'
  UPDATE order_refunds SET prev_status = NULL WHERE id = v_rid;
  ASSERT fail_order_refund(v_rid, 'null prev') = 'failed', 'null prev: fail returns failed';
  ASSERT pg_temp.st('orders', v_x) = 'pending', 'null prev_status falls back to pending';

  -- (16) privileges: none of the refund functions is executable by anon / authenticated
  SELECT count(*) INTO v_n FROM unnest(ARRAY[
      'public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid, integer)',
      'public.complete_order_refund(uuid, text)',
      'public.fail_order_refund(uuid, text)',
      'public.guard_refund_status_status()']) f
    CROSS JOIN unnest(ARRAY['anon','authenticated']) r
   WHERE has_function_privilege(r, f, 'execute');
  ASSERT v_n = 0, 'anon/authenticated must not have EXECUTE on the refund functions, got ' || v_n;

  SELECT balance INTO v_w FROM wallets WHERE user_id = v_user;
  ASSERT v_w = 50, 'no RPC in this file moves any wallet balance';
END $$;
ROLLBACK;
