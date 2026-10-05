-- Admin order refunds: ledger, dispatch claims, atomic RPCs, status guard.
-- Additive. Safe to apply before the app deploy (app code fails open if RPCs are missing).

-- ───────────────────────── tables ─────────────────────────
CREATE TABLE IF NOT EXISTS public.order_refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_table      text NOT NULL CHECK (order_table IN ('shop_orders','ussd_orders','ussd_shop_orders')),
  order_id         uuid NOT NULL,
  gateway          text NOT NULL,
  paid_amount      numeric(10,2) NOT NULL,
  gateway_fee      numeric(10,2) NOT NULL DEFAULT 0,
  amount           numeric(10,2) NOT NULL CHECK (amount > 0),
  destination_phone text,
  wallet_user_id   uuid,
  status           text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','processing','awaiting_otp','completed','failed')),
  gateway_ref      text,
  error            text,
  clawbacks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  late_events      jsonb NOT NULL DEFAULT '[]'::jsonb,
  admin_id         uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

-- The double-refund guard: at most one non-failed refund per order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_refunds_active
  ON public.order_refunds (order_table, order_id) WHERE status <> 'failed';
CREATE INDEX IF NOT EXISTS idx_order_refunds_order_id ON public.order_refunds (order_id);
CREATE INDEX IF NOT EXISTS idx_order_refunds_status_created ON public.order_refunds (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.order_dispatch_claims (
  order_id        uuid PRIMARY KEY,
  attempts        integer NOT NULL DEFAULT 0,
  last_outcome    text NOT NULL DEFAULT 'claimed' CHECK (last_outcome IN ('claimed','submitted','failed','unknown')),
  last_claimed_at timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_dispatch_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all_order_refunds" ON public.order_refunds;
CREATE POLICY "service_role_all_order_refunds" ON public.order_refunds
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all_order_dispatch_claims" ON public.order_dispatch_claims;
CREATE POLICY "service_role_all_order_dispatch_claims" ON public.order_dispatch_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.order_refunds FROM anon, authenticated;
REVOKE ALL ON public.order_dispatch_claims FROM anon, authenticated;

ALTER TABLE public.shop_profits
  ADD COLUMN IF NOT EXISTS refund_id uuid REFERENCES public.order_refunds(id);
CREATE INDEX IF NOT EXISTS idx_shop_profits_refund_id ON public.shop_profits (refund_id) WHERE refund_id IS NOT NULL;

-- ───────────────────── dispatch claim RPCs ─────────────────────
CREATE OR REPLACE FUNCTION public.claim_order_dispatch(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));
  IF EXISTS (SELECT 1 FROM order_refunds WHERE order_id = p_order_id AND status <> 'failed') THEN
    RETURN false;
  END IF;
  INSERT INTO order_dispatch_claims (order_id, attempts, last_outcome, last_claimed_at, updated_at)
  VALUES (p_order_id, 1, 'claimed', now(), now())
  ON CONFLICT (order_id) DO UPDATE
    SET attempts = order_dispatch_claims.attempts + 1,
        last_outcome = 'claimed', last_claimed_at = now(), updated_at = now();
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.record_dispatch_outcome(p_order_id uuid, p_outcome text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_outcome NOT IN ('submitted','failed','unknown') THEN
    RAISE EXCEPTION 'BAD_OUTCOME';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));
  UPDATE order_dispatch_claims SET last_outcome = p_outcome, updated_at = now() WHERE order_id = p_order_id;
END $$;

-- ───────────────────── reserve + clawback ─────────────────────
CREATE OR REPLACE FUNCTION public.reserve_order_refund(
  p_order_table text, p_order_id uuid, p_gateway text,
  p_paid numeric, p_fee numeric, p_amount numeric,
  p_destination text, p_wallet_user uuid, p_admin uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fk text;
  v_status text; v_pay text;
  v_outcome text;
  v_refund_id uuid := gen_random_uuid();
  v_lines jsonb := '[]'::jsonb;
  r record;
  v_owner uuid; v_avail numeric; v_from_profit numeric; v_from_wallet numeric; v_new_bal numeric;
BEGIN
  IF p_order_table NOT IN ('shop_orders','ussd_orders','ussd_shop_orders') THEN RAISE EXCEPTION 'BAD_TABLE'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_paid IS NULL OR p_amount > p_paid THEN RAISE EXCEPTION 'BAD_AMOUNT'; END IF;
  v_fk := CASE p_order_table
            WHEN 'shop_orders' THEN 'shop_order_id'
            WHEN 'ussd_orders' THEN 'ussd_order_id'
            ELSE 'ussd_shop_order_id' END;

  -- Same lock the dispatch claim takes: exactly one of refund/dispatch wins.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));

  EXECUTE format('SELECT order_status, payment_status FROM %I WHERE id = $1 FOR UPDATE', p_order_table)
    INTO v_status, v_pay USING p_order_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_status IS DISTINCT FROM 'pending' OR v_pay IS DISTINCT FROM 'completed' THEN RAISE EXCEPTION 'ORDER_NOT_PENDING'; END IF;
  IF EXISTS (SELECT 1 FROM order_refunds WHERE order_id = p_order_id AND status <> 'failed') THEN
    RAISE EXCEPTION 'ALREADY_REFUNDED';
  END IF;
  SELECT last_outcome INTO v_outcome FROM order_dispatch_claims WHERE order_id = p_order_id;
  IF v_outcome IN ('claimed','unknown') THEN RAISE EXCEPTION 'DISPATCH_ACTIVE'; END IF;

  -- refund row first: shop_profits.refund_id references it
  INSERT INTO order_refunds (id, order_table, order_id, gateway, paid_amount, gateway_fee, amount,
                             destination_phone, wallet_user_id, status, admin_id)
  VALUES (v_refund_id, p_order_table, p_order_id, p_gateway, p_paid, COALESCE(p_fee,0), p_amount,
          p_destination, p_wallet_user, 'reserved', p_admin);

  -- Owners in fixed (shop_id) order => deterministic lock order, no deadlocks.
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

    IF r.pending <> 0 THEN
      INSERT INTO shop_profits (shop_id, profit_amount, status, refund_id, notes, created_at, updated_at)
      VALUES (r.shop_id, -r.pending, 'pending', v_refund_id, 'Order refund reversal (pending portion)', now(), now());
    END IF;

    v_lines := v_lines || jsonb_build_object(
      'shop_id', r.shop_id, 'owner_user_id', v_owner,
      'credited', r.credited, 'pending', r.pending,
      'from_profit', v_from_profit, 'from_wallet', v_from_wallet);
  END LOOP;

  UPDATE order_refunds SET clawbacks = v_lines, updated_at = now() WHERE id = v_refund_id;

  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET order_status = ''refunding'', updated_at = now() WHERE id = $1', p_order_table)
    USING p_order_id;
  PERFORM set_config('app.refund_rpc', 'off', true);

  RETURN jsonb_build_object('refund_id', v_refund_id, 'clawbacks', v_lines);
END $$;

-- ───────────────────── settle / compensate ─────────────────────
CREATE OR REPLACE FUNCTION public.mark_refund_processing(
  p_refund_id uuid, p_gateway_ref text, p_note text, p_status text DEFAULT 'processing')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('processing','awaiting_otp') THEN RAISE EXCEPTION 'BAD_STATUS'; END IF;
  UPDATE order_refunds
     SET status = p_status, gateway_ref = COALESCE(p_gateway_ref, gateway_ref),
         error = p_note, updated_at = now()
   WHERE id = p_refund_id AND status IN ('reserved','processing','awaiting_otp');
END $$;

CREATE OR REPLACE FUNCTION public.complete_order_refund(p_refund_id uuid, p_gateway_ref text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_table text; v_order uuid;
BEGIN
  SELECT order_table, order_id INTO v_table, v_order FROM order_refunds
   WHERE id = p_refund_id AND status IN ('reserved','processing','awaiting_otp') FOR UPDATE;
  IF v_table IS NULL THEN RETURN; END IF;
  UPDATE order_refunds SET status = 'completed', gateway_ref = COALESCE(p_gateway_ref, gateway_ref),
         error = NULL, completed_at = now(), updated_at = now() WHERE id = p_refund_id;
  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET order_status = ''refunded'', updated_at = now() WHERE id = $1', v_table) USING v_order;
  PERFORM set_config('app.refund_rpc', 'off', true);
END $$;

CREATE OR REPLACE FUNCTION public.fail_order_refund(p_refund_id uuid, p_error text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_table text; v_order uuid; v_lines jsonb;
  l jsonb; v_wallet_new numeric;
BEGIN
  SELECT order_table, order_id, clawbacks INTO v_table, v_order, v_lines FROM order_refunds
   WHERE id = p_refund_id AND status IN ('reserved','processing','awaiting_otp') FOR UPDATE;
  IF v_table IS NULL THEN RETURN; END IF;   -- already failed/completed: idempotent

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
      INSERT INTO transactions (user_id, amount, type, status, description, reference_id, source,
                                balance_before, balance_after, created_at)
      VALUES ((l->>'owner_user_id')::uuid, (l->>'from_wallet')::numeric, 'credit', 'completed',
              'Order refund clawback restored', 'REFUND_CLAWBACK_UNDO_' || p_refund_id || '_' || (l->>'shop_id'),
              'refund_clawback_undo', v_wallet_new - (l->>'from_wallet')::numeric, v_wallet_new, now());
    END IF;
  END LOOP;

  UPDATE order_refunds SET status = 'failed', error = p_error, updated_at = now() WHERE id = p_refund_id;
  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET order_status = ''pending'', updated_at = now() WHERE id = $1', v_table) USING v_order;
  PERFORM set_config('app.refund_rpc', 'off', true);
END $$;

-- ───────────────────── status guard trigger ─────────────────────
-- A late provider webhook / cron must not move a refunding/refunded order.
CREATE OR REPLACE FUNCTION public.guard_refund_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.order_status IN ('refunding','refunded')
     AND NEW.order_status IS DISTINCT FROM OLD.order_status
     AND COALESCE(current_setting('app.refund_rpc', true), '') <> 'on' THEN
    UPDATE public.order_refunds
       SET late_events = late_events || jsonb_build_object('at', now(), 'attempted_status', NEW.order_status)
     WHERE order_id = OLD.id AND status IN ('reserved','processing','awaiting_otp','completed');
    RAISE WARNING 'refund guard: blocked % -> % on %.%', OLD.order_status, NEW.order_status, TG_TABLE_NAME, OLD.id;
    NEW.order_status := OLD.order_status;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.shop_orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.shop_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_refund_status();
DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.ussd_orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.ussd_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_refund_status();
DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.ussd_shop_orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.ussd_shop_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_refund_status();

-- ───────────────────── privileges ─────────────────────
REVOKE EXECUTE ON FUNCTION public.claim_order_dispatch(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_dispatch_outcome(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_refund_processing(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_order_refund(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_order_refund(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_dispatch(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_dispatch_outcome(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_refund_processing(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_refund(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_order_refund(uuid, text) TO service_role;
