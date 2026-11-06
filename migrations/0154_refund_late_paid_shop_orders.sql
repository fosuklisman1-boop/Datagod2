-- 0154_refund_late_paid_shop_orders.sql
-- A payment that lands on a closed shop order now records nothing on the order (no flip, no profit), so the money is
-- proven only by a completed wallet_payments row. The refund tool must be able to return it.
--
-- reserve_order_refund is copied VERBATIM from 0123; the only change is the v_late rule. The status moves it makes on
-- such a row (expired -> refunding -> refunded, or back to expired) are allowed by enforce_order_state_machine
-- (20260716): that trigger only guards exits from completed. payment_status is left as it is.
-- late_paid_shop_order_ids feeds the pending list. Bounded to 90 days: the row is found by its alert long before that.
-- Additive and idempotent. Safe either side of the app deploy: until applied, the RPC refuses these rows as before and
-- the list omits them.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.late_paid_shop_order_ids(p_shop_id uuid DEFAULT NULL)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id FROM shop_orders o
   WHERE o.order_status IN ('expired','failed','cancelled','canceled','abandoned')
     AND o.payment_status IS DISTINCT FROM 'completed'
     AND o.created_at > now() - interval '90 days'
     AND (p_shop_id IS NULL OR o.shop_id = p_shop_id)
     AND EXISTS (SELECT 1 FROM wallet_payments w WHERE w.order_id = o.id AND w.status = 'completed')
   ORDER BY o.created_at DESC
   LIMIT 500
$$;
REVOKE ALL ON FUNCTION public.late_paid_shop_order_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_paid_shop_order_ids(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_order_refund(
  p_order_table text, p_order_id uuid, p_gateway text,
  p_paid numeric, p_fee numeric, p_amount numeric,
  p_destination text, p_wallet_user uuid, p_admin uuid,
  p_expected_attempts integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_fk text;
  v_col text;
  v_has_profits boolean;
  v_status text; v_pay text;
  v_refundable boolean;
  v_late boolean := false;
  v_outcome text;
  v_refund_id uuid := gen_random_uuid();
  v_lines jsonb := '[]'::jsonb;
  r record;
  v_owner uuid; v_avail numeric; v_from_profit numeric; v_from_wallet numeric; v_new_bal numeric;
  v_storefront boolean;
BEGIN
  IF p_order_table NOT IN ('shop_orders','ussd_orders','ussd_shop_orders','orders','api_orders',
                           'airtime_orders','hubtel_bill_orders','hubtel_data_orders') THEN RAISE EXCEPTION 'BAD_TABLE'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_paid IS NULL OR p_amount > p_paid THEN RAISE EXCEPTION 'BAD_AMOUNT'; END IF;

  -- The original three tables carry shop profits + order_status/payment_status; orders/api_orders have neither;
  -- the commission tables carry shop profits + status/payment_status.
  v_has_profits := p_order_table IN ('shop_orders','ussd_orders','ussd_shop_orders',
                                     'airtime_orders','hubtel_bill_orders','hubtel_data_orders');
  v_col := CASE WHEN p_order_table IN ('shop_orders','ussd_orders','ussd_shop_orders') THEN 'order_status' ELSE 'status' END;
  v_fk := CASE p_order_table
            WHEN 'shop_orders' THEN 'shop_order_id'
            WHEN 'ussd_orders' THEN 'ussd_order_id'
            WHEN 'ussd_shop_orders' THEN 'ussd_shop_order_id'
            WHEN 'airtime_orders' THEN 'airtime_order_id'
            WHEN 'hubtel_bill_orders' THEN 'bill_order_id'
            WHEN 'hubtel_data_orders' THEN 'data_order_id'
            ELSE NULL END;

  -- Same lock the dispatch claim takes: exactly one of refund/dispatch wins.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));

  IF p_order_table IN ('shop_orders','ussd_orders','ussd_shop_orders') THEN
    EXECUTE format('SELECT order_status, payment_status FROM %I WHERE id = $1 FOR UPDATE', p_order_table)
      INTO v_status, v_pay USING p_order_id;
  ELSIF p_order_table = 'airtime_orders' THEN
    -- Paid airtime rows carry payment_status 'completed'. Only non-wallet (user_id IS NULL) rows qualify.
    SELECT status, payment_status, (user_id IS NULL) INTO v_status, v_pay, v_storefront
      FROM airtime_orders WHERE id = p_order_id FOR UPDATE;
  ELSIF p_order_table IN ('hubtel_bill_orders','hubtel_data_orders') THEN
    -- Paid bill/bundle rows carry payment_status 'paid' (normalised to 'completed' for the check below).
    -- 0123: bot rows (channel 'bots') are non-wallet like storefront rows.
    EXECUTE format('SELECT status, CASE WHEN payment_status = ''paid'' THEN ''completed'' ELSE payment_status END,
                           (channel IN (''storefront'',''bots'')) FROM %I WHERE id = $1 FOR UPDATE', p_order_table)
      INTO v_status, v_pay, v_storefront USING p_order_id;
  ELSE
    EXECUTE format('SELECT status FROM %I WHERE id = $1 FOR UPDATE', p_order_table)
      INTO v_status USING p_order_id;
    v_pay := 'completed'; -- paid from the buyer's wallet at purchase; the order row has no payment_status
  END IF;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF p_order_table IN ('airtime_orders','hubtel_bill_orders','hubtel_data_orders') AND v_storefront IS NOT TRUE THEN
    RAISE EXCEPTION 'BAD_CHANNEL';
  END IF;

  v_refundable := CASE
                    WHEN p_order_table = 'api_orders' THEN v_status IN ('pending','held_registration')
                    WHEN p_order_table IN ('airtime_orders','hubtel_bill_orders','hubtel_data_orders') THEN v_status IN ('pending','failed')
                    ELSE v_status = 'pending' END;
  -- 0154: a shop order closed before its payment landed. The order records nothing; the wallet payment is the proof.
  IF p_order_table = 'shop_orders'
     AND v_status IN ('expired','failed','cancelled','canceled','abandoned')
     AND v_pay IS DISTINCT FROM 'completed' THEN
    v_late := EXISTS (SELECT 1 FROM wallet_payments WHERE order_id = p_order_id AND status = 'completed');
  END IF;
  IF NOT v_late AND (NOT v_refundable OR v_pay IS DISTINCT FROM 'completed') THEN RAISE EXCEPTION 'ORDER_NOT_PENDING'; END IF;
  IF EXISTS (SELECT 1 FROM order_refunds WHERE order_id = p_order_id AND status <> 'failed') THEN
    RAISE EXCEPTION 'ALREADY_REFUNDED';
  END IF;
  SELECT last_outcome INTO v_outcome FROM order_dispatch_claims WHERE order_id = p_order_id;
  IF v_outcome IN ('claimed','unknown') THEN RAISE EXCEPTION 'DISPATCH_ACTIVE'; END IF;
  -- A dispatch may have claimed (and finished) between the caller's eligibility read and now:
  -- the claim count the admin saw must still be the claim count.
  IF p_expected_attempts IS NOT NULL
     AND COALESCE((SELECT attempts FROM order_dispatch_claims WHERE order_id = p_order_id), 0) <> p_expected_attempts THEN
    RAISE EXCEPTION 'DISPATCH_ACTIVE';
  END IF;

  -- refund row first: shop_profits.refund_id references it
  INSERT INTO order_refunds (id, order_table, order_id, gateway, paid_amount, gateway_fee, amount,
                             destination_phone, wallet_user_id, status, admin_id, prev_status)
  VALUES (v_refund_id, p_order_table, p_order_id, p_gateway, p_paid, COALESCE(p_fee,0), p_amount,
          p_destination, p_wallet_user, 'reserved', p_admin, v_status);

  -- Owners in fixed (shop_id) order => deterministic lock order, no deadlocks.
  -- Only tables with a shop_profits FK column have owners; orders/api_orders have none.
  IF v_has_profits THEN
    FOR r IN EXECUTE format(
      'SELECT shop_id,
              COALESCE(SUM(profit_amount) FILTER (WHERE status = ''credited''), 0) AS credited,
              COALESCE(SUM(profit_amount) FILTER (WHERE status = ''pending''), 0)  AS pending
         FROM shop_profits WHERE %I = $1 AND refund_id IS NULL
        GROUP BY shop_id ORDER BY shop_id', v_fk) USING p_order_id
    LOOP
      CONTINUE WHEN r.credited = 0 AND r.pending = 0;
      SELECT user_id INTO v_owner FROM user_shops WHERE id = r.shop_id;
      v_from_profit := 0; v_from_wallet := 0;

      IF r.credited > 0 THEN
        PERFORM sync_shop_balance(r.shop_id);
        SELECT available_balance INTO v_avail FROM shop_available_balance WHERE shop_id = r.shop_id FOR UPDATE;
        v_from_profit := LEAST(r.credited, GREATEST(COALESCE(v_avail, 0), 0));
        v_from_wallet := r.credited - v_from_profit;

        IF v_from_wallet > 0 THEN
          UPDATE wallets SET balance = balance - v_from_wallet, updated_at = now()
           WHERE user_id = v_owner AND balance >= v_from_wallet
          RETURNING balance INTO v_new_bal;
          IF NOT FOUND OR v_owner IS NULL THEN
            RAISE EXCEPTION 'SHORTFALL:%:%', r.shop_id, v_from_wallet;
          END IF;
          INSERT INTO transactions (user_id, amount, type, status, description, reference_id, source,
                                    balance_before, balance_after, created_at)
          VALUES (v_owner, v_from_wallet, 'debit', 'completed', 'Order refund clawback',
                  'REFUND_CLAWBACK_' || v_refund_id || '_' || r.shop_id, 'refund_clawback',
                  v_new_bal + v_from_wallet, v_new_bal, now());
        END IF;

        IF v_from_profit > 0 THEN
          INSERT INTO shop_profits (shop_id, profit_amount, status, refund_id, notes, created_at, updated_at)
          VALUES (r.shop_id, -v_from_profit, 'credited', v_refund_id, 'Order refund reversal', now(), now());
        END IF;
      END IF;

      -- NOTE: 'pending'-status profit rows are legacy (the only writer, createProfitRecord, has no callers;
      -- live paths insert 'credited'). A per-order pending->credited flip elsewhere would not honour this reversal.
      IF r.pending <> 0 THEN
        INSERT INTO shop_profits (shop_id, profit_amount, status, refund_id, notes, created_at, updated_at)
        VALUES (r.shop_id, -r.pending, 'pending', v_refund_id, 'Order refund reversal (pending portion)', now(), now());
      END IF;

      v_lines := v_lines || jsonb_build_object(
        'shop_id', r.shop_id, 'owner_user_id', v_owner,
        'credited', r.credited, 'pending', r.pending,
        'from_profit', v_from_profit, 'from_wallet', v_from_wallet);
    END LOOP;
  END IF;

  UPDATE order_refunds SET clawbacks = v_lines, updated_at = now() WHERE id = v_refund_id;

  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET %I = ''refunding'', updated_at = now() WHERE id = $1', p_order_table, v_col)
    USING p_order_id;
  PERFORM set_config('app.refund_rpc', 'off', true);

  RETURN jsonb_build_object('refund_id', v_refund_id, 'clawbacks', v_lines);
END $$;

-- privileges (CREATE OR REPLACE keeps them; re-stated so the migration is self-contained)
REVOKE ALL ON FUNCTION public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
