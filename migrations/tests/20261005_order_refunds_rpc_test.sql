BEGIN;
DO $$
DECLARE
  v_shop uuid; v_owner uuid; v_order uuid; v_order2 uuid; v_res jsonb; v_rid uuid;
  v_avail numeric; v_wallet numeric; v_status text; v_claim boolean; v_err text;
BEGIN
  SELECT id, user_id INTO v_shop, v_owner FROM user_shops WHERE user_id IS NOT NULL LIMIT 1;
  ASSERT v_shop IS NOT NULL, 'need at least one shop to run this test';

  UPDATE wallets SET balance = 0 WHERE user_id = v_owner;
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, balance) VALUES (v_owner, 0);
  END IF;

  -- order 1: owner credited 10, available covers it
  INSERT INTO ussd_orders (dialing_phone, recipient_phone, network, paystack_provider, amount, order_status, payment_status)
    VALUES ('0240000001','0240000001','MTN','mtn', 12, 'pending', 'completed') RETURNING id INTO v_order;
  INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_shop, v_order, 10, 'credited');
  SELECT available_balance INTO v_avail FROM shop_available_balance WHERE shop_id = v_shop;
  ASSERT v_avail >= 10, 'sync trigger should have credited the available balance';

  -- (1) happy path: profit covers the cut
  v_res := reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, '0240000001', NULL, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  ASSERT (v_res->'clawbacks'->0->>'from_profit')::numeric = 10, 'cut taken from profit';
  ASSERT (v_res->'clawbacks'->0->>'from_wallet')::numeric = 0, 'no wallet needed';
  EXECUTE 'SELECT order_status FROM ussd_orders WHERE id = $1' INTO v_status USING v_order;
  ASSERT v_status = 'refunding', 'order locked as refunding';
  SELECT available_balance INTO v_wallet FROM shop_available_balance WHERE shop_id = v_shop;
  ASSERT v_wallet = v_avail - 10, 'available balance reduced by the cut';

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
  EXECUTE 'SELECT order_status FROM ussd_orders WHERE id = $1' INTO v_status USING v_order;
  ASSERT v_status = 'refunding', 'guard keeps refunding status';
  ASSERT jsonb_array_length((SELECT late_events FROM order_refunds WHERE id = v_rid)) = 1, 'late event recorded';

  -- (5) compensation restores balance and order
  PERFORM fail_order_refund(v_rid, 'gateway said no');
  PERFORM fail_order_refund(v_rid, 'second call is a no-op');
  EXECUTE 'SELECT order_status FROM ussd_orders WHERE id = $1' INTO v_status USING v_order;
  ASSERT v_status = 'pending', 'order back to pending';
  SELECT available_balance INTO v_wallet FROM shop_available_balance WHERE shop_id = v_shop;
  ASSERT v_wallet = v_avail, 'available balance fully restored';

  -- (5b) awaiting_otp keeps the clawback; compensation still works from that state
  v_res := reserve_order_refund('ussd_orders', v_order, 'paystack_payout', 12, 0, 12, '0240000001', NULL, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  PERFORM mark_refund_processing(v_rid, 'TRF_TEST', 'Waiting for the payout OTP', 'awaiting_otp');
  ASSERT (SELECT status FROM order_refunds WHERE id = v_rid) = 'awaiting_otp', 'status awaiting_otp';
  ASSERT (SELECT gateway_ref FROM order_refunds WHERE id = v_rid) = 'TRF_TEST', 'transfer code persisted';
  SELECT available_balance INTO v_wallet FROM shop_available_balance WHERE shop_id = v_shop;
  ASSERT v_wallet = v_avail - 10, 'clawback still in place while awaiting OTP';
  BEGIN
    PERFORM mark_refund_processing(v_rid, NULL, 'x', 'bogus');
    ASSERT false, 'bad status must be rejected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'BAD_STATUS', 'got: ' || v_err;
  END;
  PERFORM fail_order_refund(v_rid, 'cancelled before OTP');
  SELECT available_balance INTO v_wallet FROM shop_available_balance WHERE shop_id = v_shop;
  ASSERT v_wallet = v_avail, 'cancel from awaiting_otp restores the balance';

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

  -- (7) shortfall: cut larger than available + wallet is blocked and leaves no trace
  INSERT INTO ussd_orders (dialing_phone, recipient_phone, network, paystack_provider, amount, order_status, payment_status)
    VALUES ('0240000002','0240000002','MTN','mtn', 100000, 'pending', 'completed') RETURNING id INTO v_order2;
  INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_shop, v_order2, 99999, 'credited');
  SELECT available_balance INTO v_avail FROM shop_available_balance WHERE shop_id = v_shop;
  UPDATE wallets SET balance = 0 WHERE user_id = v_owner;
  -- force available to zero by recording a large completed withdrawal
  INSERT INTO withdrawal_requests (shop_id, user_id, amount, withdrawal_method, status)
    VALUES (v_shop, v_owner, v_avail, 'wallet', 'completed');
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', v_order2, 'wallet', 100000, 0, 100000, NULL, NULL, NULL);
    ASSERT false, 'shortfall must block';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err LIKE 'SHORTFALL:%', 'got: ' || v_err;
  END;
  EXECUTE 'SELECT order_status FROM ussd_orders WHERE id = $1' INTO v_status USING v_order2;
  ASSERT v_status = 'pending', 'order untouched after shortfall';
  ASSERT NOT EXISTS (SELECT 1 FROM order_refunds WHERE order_id = v_order2), 'no refund row after shortfall';
END $$;
ROLLBACK;
