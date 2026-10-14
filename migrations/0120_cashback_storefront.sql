-- 0120_cashback_storefront.sql
-- Commission cashback Plan A (storefronts): storefront rows on the Hubtel bill/bundle tables, payment-fee
-- snapshot on airtime, shop_profits links for bill/bundle orders, and the three commission order tables in
-- the /admin/refunds ledger + RPCs.
-- ADDITIVE; service-role only. NOT applied by the implementing agent. Apply AFTER 0117, 0118, 0119,
-- 20261005_order_refunds.sql and 20261007_refunds_bulk_api_orders.sql.
-- One transaction (Parts 1-5), then one standalone VALIDATE (Part 6). Idempotent (re-runnable).
--
-- PRE-CHECKS (each must return zero rows / the stated value before applying):
--   -- storefront idempotency index is new; there are no storefront rows yet:
--   SELECT count(*) FROM hubtel_data_orders WHERE channel <> 'dashboard';            -- expect 0
--   -- the airtime status CHECK must be a plain IN-list (Part 4 aborts otherwise):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.airtime_orders'::regclass AND conname = 'airtime_orders_status_check';
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ───────────────────── Part 1: storefront rows on hubtel_bill_orders / hubtel_data_orders ─────────────────────
-- The inline channel CHECKs from 0117/0118 are auto-named <table>_channel_check.
ALTER TABLE public.hubtel_bill_orders DROP CONSTRAINT IF EXISTS hubtel_bill_orders_channel_check;
ALTER TABLE public.hubtel_bill_orders ADD CONSTRAINT hubtel_bill_orders_channel_check
  CHECK (channel IN ('dashboard','storefront','api'));
ALTER TABLE public.hubtel_data_orders DROP CONSTRAINT IF EXISTS hubtel_data_orders_channel_check;
ALTER TABLE public.hubtel_data_orders ADD CONSTRAINT hubtel_data_orders_channel_check
  CHECK (channel IN ('dashboard','storefront','api'));

-- Storefront customers are anonymous: user_id is required only for dashboard (wallet-paid) rows.
ALTER TABLE public.hubtel_bill_orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.hubtel_data_orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.hubtel_bill_orders DROP CONSTRAINT IF EXISTS hubtel_bill_orders_dashboard_user_check;
ALTER TABLE public.hubtel_bill_orders ADD CONSTRAINT hubtel_bill_orders_dashboard_user_check
  CHECK (channel <> 'dashboard' OR user_id IS NOT NULL);
ALTER TABLE public.hubtel_data_orders DROP CONSTRAINT IF EXISTS hubtel_data_orders_dashboard_user_check;
ALTER TABLE public.hubtel_data_orders ADD CONSTRAINT hubtel_data_orders_dashboard_user_check
  CHECK (channel <> 'dashboard' OR user_id IS NOT NULL);

-- Refund states: the refund RPCs move an order to 'refunding' then 'refunded' (0117/0118 had 'refunded' only).
-- The inline status CHECKs from 0117/0118 are auto-named <table>_status_check.
ALTER TABLE public.hubtel_bill_orders DROP CONSTRAINT IF EXISTS hubtel_bill_orders_status_check;
ALTER TABLE public.hubtel_bill_orders ADD CONSTRAINT hubtel_bill_orders_status_check
  CHECK (status IN ('pending','processing','completed','failed','refunding','refunded'));
ALTER TABLE public.hubtel_data_orders DROP CONSTRAINT IF EXISTS hubtel_data_orders_status_check;
ALTER TABLE public.hubtel_data_orders ADD CONSTRAINT hubtel_data_orders_status_check
  CHECK (status IN ('pending','processing','completed','failed','refunding','refunded'));

-- NOTE: hubtel_bill_orders.customer_name already exists (0117: the biller-verified account name), so the
-- ADD COLUMN below is a no-op there; the storefront buyer's name shares that column on bill rows.
ALTER TABLE public.hubtel_bill_orders
  ADD COLUMN IF NOT EXISTS shop_id            uuid,
  ADD COLUMN IF NOT EXISTS customer_email     text,
  ADD COLUMN IF NOT EXISTS customer_name      text,
  ADD COLUMN IF NOT EXISTS payment_fee_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS payment_reference  text,
  ADD COLUMN IF NOT EXISTS refund_method      text,
  ADD COLUMN IF NOT EXISTS paid_at            timestamptz;

ALTER TABLE public.hubtel_data_orders
  ADD COLUMN IF NOT EXISTS shop_id            uuid,
  ADD COLUMN IF NOT EXISTS customer_email     text,
  ADD COLUMN IF NOT EXISTS customer_name      text,
  ADD COLUMN IF NOT EXISTS payment_fee_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS payment_reference  text,
  ADD COLUMN IF NOT EXISTS refund_method      text,
  ADD COLUMN IF NOT EXISTS paid_at            timestamptz;

CREATE INDEX IF NOT EXISTS hubtel_bill_orders_shop_idx ON public.hubtel_bill_orders (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hubtel_data_orders_shop_idx ON public.hubtel_data_orders (shop_id, created_at DESC);

-- Storefront rows have user_id NULL, so 0118's UNIQUE (user_id, idempotency_key) never dedupes them
-- (NULLs are distinct). Dedupe storefront bundle orders per shop instead.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hubtel_data_orders_storefront_idem
  ON public.hubtel_data_orders (shop_id, idempotency_key) WHERE channel = 'storefront';

-- ───────────────────── Part 2: airtime payment-fee snapshot ─────────────────────
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS payment_fee_amount numeric(12,2);

-- ───────────────────── Part 3: shop_profits links for bill / bundle orders ─────────────────────
-- Same pattern as airtime_order_id (profit_disbursement_v1.sql: nullable FK, ON DELETE SET NULL).
ALTER TABLE public.shop_profits
  ADD COLUMN IF NOT EXISTS bill_order_id uuid REFERENCES public.hubtel_bill_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS data_order_id uuid REFERENCES public.hubtel_data_orders(id) ON DELETE SET NULL;

-- Credit once per (order, shop), mirroring 0108's uq_shop_profits_airtime_order_shop. Refund clawback/undo rows
-- never set the order FK columns (they set refund_id only), and profit_amount > 0 additionally keeps any
-- negative row out of the key. Both columns are brand new (all NULL), so the build is instant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_profits_bill_order_shop
  ON public.shop_profits (bill_order_id, shop_id) WHERE bill_order_id IS NOT NULL AND profit_amount > 0;
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_profits_data_order_shop
  ON public.shop_profits (data_order_id, shop_id) WHERE data_order_id IS NOT NULL AND profit_amount > 0;

-- ───────────────────── Part 4: airtime refund states ─────────────────────
-- The live airtime_orders_status_check is not reliably described by the repo (code writes 'expired', which
-- fix_airtime_orders_guest_columns.sql does not list), so it is rebuilt from its LIVE definition plus
-- 'refunding','refunded'. NOT VALID here (no table scan under the exclusive lock); validated in Part 6.
-- Aborts the whole migration if the live CHECK is not a plain `status = ANY (ARRAY[...])` list.
DO $$
DECLARE v_def text; v_vals text[]; v_list text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.airtime_orders'::regclass AND c.conname = 'airtime_orders_status_check';
  IF v_def IS NULL THEN RETURN; END IF;  -- no CHECK: every status is already accepted
  IF v_def LIKE '%''refunding''%' AND v_def LIKE '%''refunded''%' THEN RETURN; END IF;  -- re-run
  IF v_def !~ '^CHECK \(\(status = ANY \(ARRAY\[' THEN
    RAISE EXCEPTION 'airtime_orders_status_check has an unexpected shape, widen it by hand: %', v_def;
  END IF;
  SELECT array_agg(m[1]) INTO v_vals FROM regexp_matches(v_def, '''([^'']*)''', 'g') AS m;
  SELECT string_agg(quote_literal(x), ',' ORDER BY x) INTO v_list
    FROM (SELECT DISTINCT unnest(v_vals || ARRAY['refunding','refunded']) AS x) s;
  EXECUTE 'ALTER TABLE public.airtime_orders DROP CONSTRAINT airtime_orders_status_check';
  EXECUTE format('ALTER TABLE public.airtime_orders ADD CONSTRAINT airtime_orders_status_check CHECK (status IN (%s)) NOT VALID', v_list);
END $$;

-- ───────────────────── Part 5: refunds ledger + RPCs ─────────────────────
-- Differences of the three new tables from the existing five:
--   * status column is `status` (like orders/api_orders); payment column is `payment_status`
--     (airtime: 'completed' when paid; bills/bundles: 'paid' when paid)
--   * refundable statuses: {pending, failed} (a failed Hubtel order is refundable; the app also checks the
--     Hubtel ledger), and only for non-wallet orders: airtime user_id IS NULL, bills/bundles channel 'storefront'
--     (wallet-paid rows already have their own refund paths)
--   * shop_profits FK columns: airtime_order_id / bill_order_id / data_order_id => owner clawback applies
--   * on completion, bills/bundles also get payment_status = 'refunded' (allowed by 0117/0118);
--     airtime payment_status is left untouched (Paystack verify/webhook paths key off it)
--   * prev_status 'failed' is restored on a failed refund (never 'pending', which would be re-dispatchable)

-- The CHECK from 20261007 is named order_refunds_order_table_check.
ALTER TABLE public.order_refunds DROP CONSTRAINT IF EXISTS order_refunds_order_table_check;
ALTER TABLE public.order_refunds ADD CONSTRAINT order_refunds_order_table_check
  CHECK (order_table IN ('shop_orders','ussd_orders','ussd_shop_orders','orders','api_orders',
                         'airtime_orders','hubtel_bill_orders','hubtel_data_orders'));

-- reserve (same signature as 20261005/20261007)
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
    EXECUTE format('SELECT status, CASE WHEN payment_status = ''paid'' THEN ''completed'' ELSE payment_status END,
                           (channel = ''storefront'') FROM %I WHERE id = $1 FOR UPDATE', p_order_table)
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

-- complete (same signature; status column per table)
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
  v_col := CASE WHEN v_table IN ('orders','api_orders','airtime_orders','hubtel_bill_orders','hubtel_data_orders')
                THEN 'status' ELSE 'order_status' END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order::text, 0));
  EXECUTE format('SELECT 1 FROM %I WHERE id = $1 FOR UPDATE', v_table) INTO v_locked USING v_order;
  SELECT status INTO v_status FROM order_refunds WHERE id = p_refund_id FOR UPDATE;
  IF v_status IN ('completed','failed') THEN RETURN v_status; END IF;
  UPDATE order_refunds SET status = 'completed', gateway_ref = COALESCE(p_gateway_ref, gateway_ref),
         error = NULL, completed_at = now(), updated_at = now() WHERE id = p_refund_id;
  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET %I = ''refunded'', updated_at = now() WHERE id = $1', v_table, v_col) USING v_order;
  IF v_table IN ('hubtel_bill_orders','hubtel_data_orders') THEN
    EXECUTE format('UPDATE %I SET payment_status = ''refunded'', updated_at = now() WHERE id = $1', v_table) USING v_order;
  END IF;
  PERFORM set_config('app.refund_rpc', 'off', true);
  RETURN 'completed';
END $$;

-- fail / compensate (same signature; restores prev_status)
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
  v_col := CASE WHEN v_table IN ('orders','api_orders','airtime_orders','hubtel_bill_orders','hubtel_data_orders')
                THEN 'status' ELSE 'order_status' END;
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
  -- existed, and anything unexpected, go back to 'pending' exactly as before). 'failed' is restorable for the
  -- commission tables (a failed order must not become 'pending', which is re-dispatchable).
  v_restore := CASE WHEN v_prev IN ('pending','held_registration','failed') THEN v_prev ELSE 'pending' END;
  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET %I = %L, updated_at = now() WHERE id = $1', v_table, v_col, v_restore) USING v_order;
  PERFORM set_config('app.refund_rpc', 'off', true);
  RETURN 'failed';
END $$;

-- Status guard (guard_refund_status_status() from 20261007 reads NEW.status/OLD.status, which these tables have).
DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.airtime_orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.airtime_orders
  FOR EACH ROW WHEN (OLD.status IN ('refunding','refunded')) EXECUTE FUNCTION public.guard_refund_status_status();
DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.hubtel_bill_orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.hubtel_bill_orders
  FOR EACH ROW WHEN (OLD.status IN ('refunding','refunded')) EXECUTE FUNCTION public.guard_refund_status_status();
DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.hubtel_data_orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.hubtel_data_orders
  FOR EACH ROW WHEN (OLD.status IN ('refunding','refunded')) EXECUTE FUNCTION public.guard_refund_status_status();

-- privileges
REVOKE ALL ON FUNCTION public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_order_refund(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_order_refund(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_refund(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_order_refund(uuid, text) TO service_role;

COMMIT;

-- ───────────────────── Part 6: validate the rebuilt airtime CHECK (outside the transaction) ─────────────────────
-- Takes only a SHARE UPDATE EXCLUSIVE lock. It is a superset of the previous CHECK, so it cannot fail on data
-- the old CHECK accepted. No-op when the constraint is absent or already valid.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.airtime_orders'::regclass
                AND conname = 'airtime_orders_status_check' AND NOT convalidated) THEN
    ALTER TABLE public.airtime_orders VALIDATE CONSTRAINT airtime_orders_status_check;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
