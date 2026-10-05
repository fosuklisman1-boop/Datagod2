-- Rollback-safe test for the order-refund RPCs. Single transaction; always ROLLBACK.
-- Any failed ASSERT aborts the run. Fixtures make the shop's available balance and the owner's
-- wallet deterministic (independent of production data); assertions use fixture-set values/deltas.
BEGIN;

-- Fixture helpers (temp schema; vanish with the transaction).
CREATE FUNCTION pg_temp.set_avail(p_shop uuid, p_target numeric) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v numeric;
BEGIN
  PERFORM sync_shop_balance(p_shop);
  SELECT available_balance INTO v FROM shop_available_balance WHERE shop_id = p_shop;
  INSERT INTO shop_profits (shop_id, profit_amount, status) VALUES (p_shop, p_target - COALESCE(v, 0), 'credited');
  PERFORM sync_shop_balance(p_shop);
END $$;

CREATE FUNCTION pg_temp.set_wallet(p_user uuid, p_balance numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallets SET balance = p_balance WHERE user_id = p_user;
  IF NOT FOUND THEN INSERT INTO wallets (user_id, balance) VALUES (p_user, p_balance); END IF;
END $$;

CREATE FUNCTION pg_temp.mk_order(p_amount numeric) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  INSERT INTO ussd_orders (dialing_phone, recipient_phone, network, paystack_provider, amount, order_status, payment_status)
    VALUES ('0240000001', '0240000001', 'MTN', 'mtn', p_amount, 'pending', 'completed') RETURNING id INTO v;
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.avail(p_shop uuid) RETURNS numeric
LANGUAGE sql AS $$ SELECT available_balance FROM shop_available_balance WHERE shop_id = p_shop $$;

CREATE FUNCTION pg_temp.ostatus(p_order uuid) RETURNS text
LANGUAGE sql AS $$ SELECT order_status::text FROM ussd_orders WHERE id = p_order $$;

DO $$
DECLARE
  v_shop uuid; v_owner uuid; v_shop2 uuid; v_owner2 uuid;
  v_first uuid; v_second uuid; v_second_owner uuid;
  v_order uuid; v_res jsonb; v_rid uuid;
  v_w numeric; v_claim boolean; v_err text; v_n numeric; v_bb numeric; v_ba numeric;
  v_completed_at timestamptz;
BEGIN
  SELECT id, user_id INTO v_shop, v_owner FROM user_shops WHERE user_id IS NOT NULL ORDER BY id LIMIT 1;
  ASSERT v_shop IS NOT NULL, 'need at least one shop to run this test';
  SELECT id, user_id INTO v_shop2, v_owner2 FROM user_shops
   WHERE user_id IS NOT NULL AND id <> v_shop AND user_id <> v_owner ORDER BY id LIMIT 1;

  PERFORM pg_temp.set_wallet(v_owner, 0);

  -- (1) happy path: owner credited 10, available 1000 covers the cut
  v_order := pg_temp.mk_order(12);
  INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_shop, v_order, 10, 'credited');
  PERFORM pg_temp.set_avail(v_shop, 1000);
  v_res := reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, '0240000001', NULL, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  ASSERT (v_res->'clawbacks'->0->>'from_profit')::numeric = 10, 'cut taken from profit';
  ASSERT (v_res->'clawbacks'->0->>'from_wallet')::numeric = 0, 'no wallet needed';
  ASSERT pg_temp.ostatus(v_order) = 'refunding', 'order locked as refunding';
  ASSERT pg_temp.avail(v_shop) = 990, 'available balance reduced by the cut';

  -- (2) second reserve on the same order is rejected
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
    ASSERT false, 'second reserve must fail';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err IN ('ORDER_NOT_PENDING','ALREADY_REFUNDED'), 'got: ' || v_err;
  END;

  -- (3) dispatch claim is refused while a refund is active
  v_claim := claim_order_dispatch(v_order);
  ASSERT v_claim = false, 'dispatch must be refused for an order being refunded';

  -- (4) late webhook cannot move a refunding order
  UPDATE ussd_orders SET order_status = 'completed' WHERE id = v_order;
  ASSERT pg_temp.ostatus(v_order) = 'refunding', 'guard keeps refunding status';
  ASSERT jsonb_array_length((SELECT late_events FROM order_refunds WHERE id = v_rid)) = 1, 'late event recorded';

  -- (5) compensation restores balance and order; second call is a no-op
  PERFORM fail_order_refund(v_rid, 'gateway said no');
  PERFORM fail_order_refund(v_rid, 'second call is a no-op');
  ASSERT pg_temp.ostatus(v_order) = 'pending', 'order back to pending';
  ASSERT pg_temp.avail(v_shop) = 1000, 'available balance fully restored';

  -- (5b) awaiting_otp keeps the clawback; compensation still works from that state
  v_res := reserve_order_refund('ussd_orders', v_order, 'paystack_payout', 12, 0, 12, '0240000001', NULL, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  PERFORM mark_refund_processing(v_rid, 'TRF_TEST', 'Waiting for the payout OTP', 'awaiting_otp');
  ASSERT (SELECT status FROM order_refunds WHERE id = v_rid) = 'awaiting_otp', 'status awaiting_otp';
  ASSERT (SELECT gateway_ref FROM order_refunds WHERE id = v_rid) = 'TRF_TEST', 'transfer code persisted';
  ASSERT pg_temp.avail(v_shop) = 990, 'clawback still in place while awaiting OTP';
  BEGIN
    PERFORM mark_refund_processing(v_rid, NULL, 'x', 'bogus');
    ASSERT false, 'bad status must be rejected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'BAD_STATUS', 'got: ' || v_err;
  END;
  PERFORM fail_order_refund(v_rid, 'cancelled before OTP');
  ASSERT pg_temp.avail(v_shop) = 1000, 'cancel from awaiting_otp restores the balance';

  -- (6) dispatch in flight blocks a refund
  ASSERT claim_order_dispatch(v_order) = true, 'claim allowed after failed refund';
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
    ASSERT false, 'reserve must fail while claimed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'DISPATCH_ACTIVE', 'got: ' || v_err;
  END;
  PERFORM record_dispatch_outcome(v_order, 'failed');
  v_res := reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
  ASSERT v_res->>'refund_id' IS NOT NULL, 'refund allowed once dispatch outcome is failed';
  PERFORM fail_order_refund((v_res->>'refund_id')::uuid, 'cleanup');

  -- (7) shortfall: available 0 and wallet 0 cannot cover the cut => blocked, no trace
  v_order := pg_temp.mk_order(12);
  INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_shop, v_order, 10, 'credited');
  PERFORM pg_temp.set_avail(v_shop, 0);
  PERFORM pg_temp.set_wallet(v_owner, 0);
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
    ASSERT false, 'shortfall must block';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err LIKE 'SHORTFALL:%', 'got: ' || v_err;
  END;
  ASSERT pg_temp.ostatus(v_order) = 'pending', 'order untouched after shortfall';
  ASSERT NOT EXISTS (SELECT 1 FROM order_refunds WHERE order_id = v_order), 'no refund row after shortfall';

  -- (8) wallet fallback: credited 10, available 4, wallet 10 => 4 from profit, 6 from wallet
  v_order := pg_temp.mk_order(12);
  INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_shop, v_order, 10, 'credited');
  PERFORM pg_temp.set_avail(v_shop, 4);
  PERFORM pg_temp.set_wallet(v_owner, 10);
  v_res := reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  ASSERT (v_res->'clawbacks'->0->>'from_profit')::numeric = 4, 'from_profit = available';
  ASSERT (v_res->'clawbacks'->0->>'from_wallet')::numeric = 6, 'from_wallet = remainder';
  SELECT balance INTO v_w FROM wallets WHERE user_id = v_owner;
  ASSERT v_w = 4, 'wallet debited by 6';
  ASSERT pg_temp.avail(v_shop) = 0, 'available drained';
  SELECT balance_before, balance_after INTO v_bb, v_ba FROM transactions
   WHERE reference_id = 'REFUND_CLAWBACK_' || v_rid || '_' || v_shop;
  ASSERT v_bb = 10 AND v_ba = 4, 'clawback transaction balances 10 -> 4';
  ASSERT (SELECT count(*) FROM transactions WHERE reference_id LIKE 'REFUND_CLAWBACK_' || v_rid || '%') = 1, 'one clawback tx';
  PERFORM fail_order_refund(v_rid, 'undo wallet fallback');
  SELECT balance INTO v_w FROM wallets WHERE user_id = v_owner;
  ASSERT v_w = 10, 'wallet restored';
  ASSERT pg_temp.avail(v_shop) = 4, 'available restored';
  SELECT balance_before, balance_after INTO v_bb, v_ba FROM transactions
   WHERE reference_id = 'REFUND_CLAWBACK_UNDO_' || v_rid || '_' || v_shop;
  ASSERT v_bb = 4 AND v_ba = 10, 'undo transaction balances 4 -> 10';

  -- (9) pending-status portion is offset by reserve and restored by fail
  v_order := pg_temp.mk_order(12);
  INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_shop, v_order, 5, 'pending');
  v_res := reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  SELECT COALESCE(SUM(profit_amount), 0) INTO v_n FROM shop_profits
   WHERE status = 'pending' AND (ussd_order_id = v_order OR refund_id = v_rid);
  ASSERT v_n = 0, 'net pending for the order is 0 after reserve, got ' || v_n;
  PERFORM fail_order_refund(v_rid, 'undo pending');
  SELECT COALESCE(SUM(profit_amount), 0) INTO v_n FROM shop_profits
   WHERE status = 'pending' AND (ussd_order_id = v_order OR refund_id = v_rid);
  ASSERT v_n = 5, 'pending restored after fail, got ' || v_n;

  -- (10) complete: refund + order settle; complete again and a later fail are no-ops
  v_order := pg_temp.mk_order(12);
  INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_shop, v_order, 10, 'credited');
  PERFORM pg_temp.set_avail(v_shop, 1000);
  v_res := reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  PERFORM mark_refund_processing(v_rid, 'GW1', 'sent');
  PERFORM complete_order_refund(v_rid, 'GW_DONE');
  ASSERT (SELECT status FROM order_refunds WHERE id = v_rid) = 'completed', 'refund completed';
  ASSERT (SELECT gateway_ref FROM order_refunds WHERE id = v_rid) = 'GW_DONE', 'gateway ref saved';
  ASSERT pg_temp.ostatus(v_order) = 'refunded', 'order refunded';
  SELECT completed_at INTO v_completed_at FROM order_refunds WHERE id = v_rid;
  PERFORM complete_order_refund(v_rid, 'OTHER');
  ASSERT (SELECT completed_at FROM order_refunds WHERE id = v_rid) = v_completed_at, 'second complete is a no-op';
  ASSERT (SELECT gateway_ref FROM order_refunds WHERE id = v_rid) = 'GW_DONE', 'second complete did not change ref';
  PERFORM fail_order_refund(v_rid, 'late fail');
  ASSERT (SELECT status FROM order_refunds WHERE id = v_rid) = 'completed', 'fail after complete is a no-op';
  ASSERT pg_temp.ostatus(v_order) = 'refunded', 'order stays refunded';
  ASSERT pg_temp.avail(v_shop) = 990, 'clawback stays after complete + late fail';

  -- (11) validation errors
  BEGIN
    PERFORM reserve_order_refund('bogus_table', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
    ASSERT false, 'BAD_TABLE expected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'BAD_TABLE', 'got: ' || v_err;
  END;
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 0, NULL, NULL, NULL);
    ASSERT false, 'BAD_AMOUNT (0) expected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'BAD_AMOUNT', 'got: ' || v_err;
  END;
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 13, NULL, NULL, NULL);
    ASSERT false, 'BAD_AMOUNT (> paid) expected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'BAD_AMOUNT', 'got: ' || v_err;
  END;
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', gen_random_uuid(), 'wallet', 12, 0, 12, NULL, NULL, NULL);
    ASSERT false, 'ORDER_NOT_FOUND expected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'ORDER_NOT_FOUND', 'got: ' || v_err;
  END;

  -- (12) sub-agent order, two owners: only the second (processed later) is short => whole reserve aborts
  IF v_shop2 IS NULL THEN
    RAISE NOTICE 'skipping two-owner case: need a second shop with a different owner';
  ELSE
    IF v_shop < v_shop2 THEN
      v_first := v_shop; v_second := v_shop2; v_second_owner := v_owner2;
    ELSE
      v_first := v_shop2; v_second := v_shop; v_second_owner := v_owner;
    END IF;
    v_order := pg_temp.mk_order(12);
    INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_first, v_order, 10, 'credited');
    INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_second, v_order, 10, 'credited');
    PERFORM pg_temp.set_avail(v_first, 1000);
    PERFORM pg_temp.set_avail(v_second, 0);
    PERFORM pg_temp.set_wallet(v_second_owner, 0);
    BEGIN
      PERFORM reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
      ASSERT false, 'second owner shortfall must abort the whole reserve';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      ASSERT v_err LIKE 'SHORTFALL:' || v_second || ':%', 'got: ' || v_err;
    END;
    ASSERT pg_temp.avail(v_first) = 1000, 'first shop balance unchanged after aborted reserve';
    ASSERT pg_temp.ostatus(v_order) = 'pending', 'order untouched';
    ASSERT NOT EXISTS (SELECT 1 FROM order_refunds WHERE order_id = v_order), 'no refund row';
  END IF;
END $$;
ROLLBACK;
