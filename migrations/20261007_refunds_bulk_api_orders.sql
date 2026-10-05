-- Admin order refunds, phase 2: also cover `orders` (dashboard/bulk wallet-paid) and `api_orders` (API wallet-paid).
-- Apply AFTER 20261005_order_refunds.sql and BEFORE deploying the app code that offers these tables.
-- Does NOT edit the already-applied 20261005 file: it CREATE OR REPLACEs the same-signature functions
-- (so existing grants/revokes persist; they are re-asserted at the bottom anyway).
-- One transaction: either everything applies or nothing does. Idempotent (re-runnable).
--
-- Differences from the original three tables (shop_orders / ussd_orders / ussd_shop_orders):
--   * the status column is `status` (not `order_status`); there is no `payment_status` (wallet paid at purchase)
--   * refundable statuses: orders = {pending}; api_orders = {pending, held_registration}
--   * no shop_profits FK columns => no owner clawback (clawbacks = [])
--   * the status BEFORE the refund is recorded in order_refunds.prev_status and restored on failure
--     (so a held_registration API order goes back to held_registration, not pending)
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ───────────────────────── ledger table ─────────────────────────
-- The inline CHECK from 20261005 is auto-named order_refunds_order_table_check.
ALTER TABLE public.order_refunds DROP CONSTRAINT IF EXISTS order_refunds_order_table_check;
ALTER TABLE public.order_refunds ADD CONSTRAINT order_refunds_order_table_check
  CHECK (order_table IN ('shop_orders','ussd_orders','ussd_shop_orders','orders','api_orders'));

ALTER TABLE public.order_refunds ADD COLUMN IF NOT EXISTS prev_status text;

-- ───────────────────── reserve (same signature as 20261005) ─────────────────────
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
  v_outcome text;
  v_refund_id uuid := gen_random_uuid();
  v_lines jsonb := '[]'::jsonb;
  r record;
  v_owner uuid; v_avail numeric; v_from_profit numeric; v_from_wallet numeric; v_new_bal numeric;
BEGIN
  IF p_order_table NOT IN ('shop_orders','ussd_orders','ussd_shop_orders','orders','api_orders') THEN RAISE EXCEPTION 'BAD_TABLE'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_paid IS NULL OR p_amount > p_paid THEN RAISE EXCEPTION 'BAD_AMOUNT'; END IF;

  -- The three original tables carry shop profits + order_status/payment_status; orders/api_orders have neither.
  v_has_profits := p_order_table IN ('shop_orders','ussd_orders','ussd_shop_orders');
  v_col := CASE WHEN v_has_profits THEN 'order_status' ELSE 'status' END;
  v_fk := CASE p_order_table
            WHEN 'shop_orders' THEN 'shop_order_id'
            WHEN 'ussd_orders' THEN 'ussd_order_id'
            WHEN 'ussd_shop_orders' THEN 'ussd_shop_order_id'
            ELSE NULL END;

  -- Same lock the dispatch claim takes: exactly one of refund/dispatch wins.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));

  IF v_has_profits THEN
    EXECUTE format('SELECT order_status, payment_status FROM %I WHERE id = $1 FOR UPDATE', p_order_table)
      INTO v_status, v_pay USING p_order_id;
  ELSE
    EXECUTE format('SELECT status FROM %I WHERE id = $1 FOR UPDATE', p_order_table)
      INTO v_status USING p_order_id;
    v_pay := 'completed'; -- paid from the buyer's wallet at purchase; the order row has no payment_status
  END IF;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  v_refundable := CASE p_order_table
                    WHEN 'api_orders' THEN v_status IN ('pending','held_registration')
                    ELSE v_status = 'pending' END;
  IF NOT v_refundable OR v_pay IS DISTINCT FROM 'completed' THEN RAISE EXCEPTION 'ORDER_NOT_PENDING'; END IF;
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
  -- Only the original three tables have shop_profits FK columns; orders/api_orders have no owners.
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

-- ───────────────────── complete (same signature; status column per table) ─────────────────────
-- 20261005 hardcoded order_status here, which does not exist on orders/api_orders.
CREATE OR REPLACE FUNCTION public.complete_order_refund(p_refund_id uuid, p_gateway_ref text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_table text; v_order uuid; v_locked int; v_status text; v_col text;
BEGIN
  -- Returns the refund's resulting status: 'completed' (applied or already), or 'failed' if the row
  -- was already compensated (caller must treat that as a conflict: money has left).
  -- Lock order: advisory -> order row -> refund row (see 20261005).
  SELECT order_table, order_id INTO v_table, v_order FROM order_refunds WHERE id = p_refund_id;
  IF v_table IS NULL THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;
  v_col := CASE WHEN v_table IN ('orders','api_orders') THEN 'status' ELSE 'order_status' END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order::text, 0));
  EXECUTE format('SELECT 1 FROM %I WHERE id = $1 FOR UPDATE', v_table) INTO v_locked USING v_order;
  SELECT status INTO v_status FROM order_refunds WHERE id = p_refund_id FOR UPDATE;
  IF v_status IN ('completed','failed') THEN RETURN v_status; END IF;
  UPDATE order_refunds SET status = 'completed', gateway_ref = COALESCE(p_gateway_ref, gateway_ref),
         error = NULL, completed_at = now(), updated_at = now() WHERE id = p_refund_id;
  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET %I = ''refunded'', updated_at = now() WHERE id = $1', v_table, v_col) USING v_order;
  PERFORM set_config('app.refund_rpc', 'off', true);
  RETURN 'completed';
END $$;

-- ───────────────────── fail / compensate (same signature; restores prev_status) ─────────────────────
CREATE OR REPLACE FUNCTION public.fail_order_refund(p_refund_id uuid, p_error text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_table text; v_order uuid; v_lines jsonb; v_status text; v_prev text; v_restore text; v_col text;
  l jsonb; v_wallet_new numeric; v_locked int;
BEGIN
  -- Returns the refund's resulting status: 'failed' (applied or already), or 'completed' if the
  -- refund had already completed (nothing is restored; caller must treat that as a conflict).
  -- Lock order: advisory -> order row -> refund row (see 20261005).
  SELECT order_table, order_id INTO v_table, v_order FROM order_refunds WHERE id = p_refund_id;
  IF v_table IS NULL THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;
  v_col := CASE WHEN v_table IN ('orders','api_orders') THEN 'status' ELSE 'order_status' END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order::text, 0));
  EXECUTE format('SELECT 1 FROM %I WHERE id = $1 FOR UPDATE', v_table) INTO v_locked USING v_order;
  SELECT status, clawbacks, prev_status INTO v_status, v_lines, v_prev FROM order_refunds WHERE id = p_refund_id FOR UPDATE;
  IF v_status IN ('completed','failed') THEN RETURN v_status; END IF;

  FOR l IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    IF (l->>'from_profit')::numeric > 0 THEN
      INSERT INTO shop_profits (shop_id, profit_amount, status, refund_id, notes, created_at, updated_at)
      VALUES ((l->>'shop_id')::uuid, (l->>'from_profit')::numeric, 'credited', p_refund_id,
              'Order refund reversal undone', now(), now());
    END IF;
    IF (l->>'pending')::numeric <> 0 THEN
      INSERT INTO shop_profits (shop_id, profit_amount, status, refund_id, notes, created_at, updated_at)
      VALUES ((l->>'shop_id')::uuid, (l->>'pending')::numeric, 'pending', p_refund_id,
              'Order refund reversal undone (pending portion)', now(), now());
    END IF;
    IF (l->>'from_wallet')::numeric > 0 THEN
      UPDATE wallets SET balance = balance + (l->>'from_wallet')::numeric, updated_at = now()
       WHERE user_id = (l->>'owner_user_id')::uuid RETURNING balance INTO v_wallet_new;
      IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_NOT_FOUND'; END IF;
      INSERT INTO transactions (user_id, amount, type, status, description, reference_id, source,
                                balance_before, balance_after, created_at)
      VALUES ((l->>'owner_user_id')::uuid, (l->>'from_wallet')::numeric, 'credit', 'completed',
              'Order refund clawback restored', 'REFUND_CLAWBACK_UNDO_' || p_refund_id || '_' || (l->>'shop_id'),
              'refund_clawback_undo', v_wallet_new - (l->>'from_wallet')::numeric, v_wallet_new, now());
    END IF;
  END LOOP;

  UPDATE order_refunds SET status = 'failed', error = p_error, updated_at = now() WHERE id = p_refund_id;
  -- Restore the order to the status it had when the refund was reserved (rows reserved before prev_status
  -- existed, and anything unexpected, go back to 'pending' exactly as before).
  v_restore := CASE WHEN v_prev IN ('pending','held_registration') THEN v_prev ELSE 'pending' END;
  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET %I = %L, updated_at = now() WHERE id = $1', v_table, v_col, v_restore) USING v_order;
  PERFORM set_config('app.refund_rpc', 'off', true);
  RETURN 'failed';
END $$;

-- ───────────────────── status guard for tables whose column is `status` ─────────────────────
-- Same logic as guard_refund_status() (which reads NEW.order_status, a column orders/api_orders do not have).
-- A late provider webhook / cron / bulk update must not move a refunding/refunded order.
-- The triggers carry a WHEN clause so this SECURITY DEFINER function only runs for rows already in a refund state
-- (the body re-checks the condition).
CREATE OR REPLACE FUNCTION public.guard_refund_status_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status IN ('refunding','refunded')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND COALESCE(current_setting('app.refund_rpc', true), '') <> 'on' THEN
    UPDATE public.order_refunds
       SET late_events = late_events || jsonb_build_object('at', now(), 'attempted_status', NEW.status)
     WHERE order_id = OLD.id AND status IN ('reserved','processing','awaiting_otp','completed');
    RAISE WARNING 'refund guard: blocked % -> % on %.%', OLD.status, NEW.status, TG_TABLE_NAME, OLD.id;
    NEW.status := OLD.status;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.orders
  FOR EACH ROW WHEN (OLD.status IN ('refunding','refunded')) EXECUTE FUNCTION public.guard_refund_status_status();
DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.api_orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.api_orders
  FOR EACH ROW WHEN (OLD.status IN ('refunding','refunded')) EXECUTE FUNCTION public.guard_refund_status_status();

-- ───────────────────── privileges ─────────────────────
REVOKE EXECUTE ON FUNCTION public.guard_refund_status_status() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_order_refund(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_order_refund(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_refund(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_order_refund(uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
