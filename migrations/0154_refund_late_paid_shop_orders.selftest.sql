-- 0154_refund_late_paid_shop_orders.selftest.sql
--
-- NOT A MIGRATION. Local PGlite selftest (psql-only, no real database touched). Run from the repo root with a
-- runner that expands `\i` (see memory reference-pglite-sql-tests). PASSES when it prints 'SELFTEST_OK'.
--
-- Scenarios: a paid-but-expired shop order reserves and goes refunding; the real 20260716 state-machine trigger allows
-- every status move a refund makes on it (refunding, back to expired, refunded); no completed payment, a refunded order,
-- an order paid before it failed, a plain unpaid order and other tables still refuse; a pending paid order still works;
-- the list finds only late-paid rows; privileges are service_role only; idempotent re-run.
-- complete_order_refund and fail_order_refund are not redefined by 0154 (0155 covers complete).

DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $r$;

-- Just enough of the live schema for the RPCs.
CREATE TABLE public.shop_orders (id uuid PRIMARY KEY, shop_id uuid, order_status varchar, payment_status varchar, created_at timestamp DEFAULT now(), updated_at timestamptz);
CREATE TABLE public.ussd_orders (id uuid PRIMARY KEY, order_status varchar, payment_status varchar, updated_at timestamptz);
CREATE TABLE public.ussd_shop_orders (id uuid PRIMARY KEY, order_status varchar, payment_status varchar, updated_at timestamptz);
CREATE TABLE public.orders (id uuid PRIMARY KEY, status varchar, updated_at timestamptz);
CREATE TABLE public.api_orders (id uuid PRIMARY KEY, status varchar, updated_at timestamptz);
CREATE TABLE public.airtime_orders (id uuid PRIMARY KEY, status varchar, payment_status varchar, user_id uuid, updated_at timestamptz);
CREATE TABLE public.hubtel_bill_orders (id uuid PRIMARY KEY, status varchar, payment_status varchar, channel text, updated_at timestamptz);
CREATE TABLE public.hubtel_data_orders (id uuid PRIMARY KEY, status varchar, payment_status varchar, channel text, updated_at timestamptz);
CREATE TABLE public.wallet_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, status varchar);
CREATE TABLE public.order_refunds (
  id uuid PRIMARY KEY, order_table text, order_id uuid, gateway text, paid_amount numeric, gateway_fee numeric, amount numeric,
  destination_phone text, wallet_user_id uuid, status text DEFAULT 'reserved', admin_id uuid, prev_status text,
  clawbacks jsonb DEFAULT '[]'::jsonb, gateway_ref text, error text, completed_at timestamptz, updated_at timestamptz);
CREATE TABLE public.order_dispatch_claims (order_id uuid PRIMARY KEY, attempts int, last_outcome text);
CREATE TABLE public.shop_profits (id uuid DEFAULT gen_random_uuid(), shop_id uuid, profit_amount numeric, status text, refund_id uuid, notes text,
  shop_order_id uuid, ussd_order_id uuid, ussd_shop_order_id uuid, airtime_order_id uuid, bill_order_id uuid, data_order_id uuid, created_at timestamptz, updated_at timestamptz);
CREATE TABLE public.user_shops (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE public.shop_available_balance (shop_id uuid PRIMARY KEY, available_balance numeric);
CREATE TABLE public.wallets (user_id uuid PRIMARY KEY, balance numeric, updated_at timestamptz);
CREATE TABLE public.transactions (user_id uuid, amount numeric, type text, status text, description text, reference_id text, source text, balance_before numeric, balance_after numeric, created_at timestamptz);
CREATE FUNCTION public.sync_shop_balance(uuid) RETURNS void LANGUAGE sql AS 'SELECT NULL::void';

-- The real trigger function, from the migration that defines it.
\i migrations/20260716_reversed_status_state_machine.sql
CREATE TRIGGER enforce_order_state_machine BEFORE UPDATE ON public.shop_orders FOR EACH ROW EXECUTE FUNCTION public.enforce_order_state_machine();

\i migrations/0154_refund_late_paid_shop_orders.sql
-- Re-run: must be idempotent.
\i migrations/0154_refund_late_paid_shop_orders.sql

DO $selftest$
DECLARE
  LATE uuid := gen_random_uuid(); LATE2 uuid := gen_random_uuid(); NOPAY uuid := gen_random_uuid();
  DONE uuid := gen_random_uuid(); LIVE uuid := gen_random_uuid(); PAIDFAIL uuid := gen_random_uuid(); UNPAID uuid := gen_random_uuid();
  OTHER uuid := gen_random_uuid();
  v jsonb; v_rid uuid; v_st text; v_pay text; v_ids uuid[];
  ARGS text := 'text, uuid, text, numeric, numeric, numeric, text, uuid, uuid, integer';
BEGIN
  INSERT INTO public.shop_orders (id, order_status, payment_status) VALUES
    (LATE, 'expired', 'expired'), (LATE2, 'failed', 'failed'), (NOPAY, 'expired', 'expired'),
    (DONE, 'refunded', 'expired'), (LIVE, 'pending', 'completed'), (PAIDFAIL, 'failed', 'completed'), (UNPAID, 'pending', 'pending');
  INSERT INTO public.wallet_payments (order_id, status) VALUES
    (LATE, 'completed'), (LATE2, 'completed'), (NOPAY, 'pending'), (DONE, 'completed'), (LIVE, 'completed'), (PAIDFAIL, 'completed'), (UNPAID, 'completed');

  -- The list: only closed, unrecorded, with a completed payment.
  SELECT array_agg(i) INTO v_ids FROM public.late_paid_shop_order_ids(NULL) i;
  IF NOT (LATE = ANY(v_ids) AND LATE2 = ANY(v_ids)) OR cardinality(v_ids) <> 2 THEN RAISE EXCEPTION 'FAIL list: %', v_ids; END IF;

  -- Late paid: reserve -> refunding, prev_status expired, payment_status untouched.
  v := public.reserve_order_refund('shop_orders', LATE, 'paystack', 10, 0, 10, NULL, NULL, NULL, 0);
  v_rid := (v->>'refund_id')::uuid;
  SELECT order_status, payment_status INTO v_st, v_pay FROM public.shop_orders WHERE id = LATE;
  IF v_st <> 'refunding' OR v_pay <> 'expired' THEN RAISE EXCEPTION 'FAIL reserve: % %', v_st, v_pay; END IF;
  SELECT prev_status INTO v_st FROM public.order_refunds WHERE id = v_rid;
  IF v_st <> 'expired' THEN RAISE EXCEPTION 'FAIL prev_status: %', v_st; END IF;

  -- A second reserve while one is active refuses.
  BEGIN
    PERFORM public.reserve_order_refund('shop_orders', LATE, 'paystack', 10, 0, 10, NULL, NULL, NULL, 0);
    RAISE EXCEPTION 'FAIL double reserve allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%ORDER_NOT_PENDING%' AND SQLERRM NOT LIKE '%ALREADY_REFUNDED%' THEN RAISE; END IF;
  END;

  -- The state-machine trigger allows every status a refund moves this row through.
  UPDATE public.shop_orders SET order_status = 'expired' WHERE id = LATE;
  UPDATE public.shop_orders SET order_status = 'refunding' WHERE id = LATE;
  UPDATE public.shop_orders SET order_status = 'refunded' WHERE id = LATE;

  -- Refused cases.
  BEGIN PERFORM public.reserve_order_refund('shop_orders', NOPAY, 'paystack', 10, 0, 10, NULL, NULL, NULL, 0); RAISE EXCEPTION 'FAIL nopay allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%ORDER_NOT_PENDING%' THEN RAISE; END IF; END;
  BEGIN PERFORM public.reserve_order_refund('shop_orders', DONE, 'paystack', 10, 0, 10, NULL, NULL, NULL, 0); RAISE EXCEPTION 'FAIL refunded allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%ORDER_NOT_PENDING%' THEN RAISE; END IF; END;
  BEGIN PERFORM public.reserve_order_refund('shop_orders', PAIDFAIL, 'paystack', 10, 0, 10, NULL, NULL, NULL, 0); RAISE EXCEPTION 'FAIL paid+failed allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%ORDER_NOT_PENDING%' THEN RAISE; END IF; END;
  BEGIN PERFORM public.reserve_order_refund('shop_orders', UNPAID, 'paystack', 10, 0, 10, NULL, NULL, NULL, 0); RAISE EXCEPTION 'FAIL unpaid allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%ORDER_NOT_PENDING%' THEN RAISE; END IF; END;

  -- The rule is shop_orders only.
  INSERT INTO public.ussd_orders (id, order_status, payment_status) VALUES (OTHER, 'expired', 'expired');
  INSERT INTO public.wallet_payments (order_id, status) VALUES (OTHER, 'completed');
  BEGIN PERFORM public.reserve_order_refund('ussd_orders', OTHER, 'paystack', 10, 0, 10, NULL, NULL, NULL, 0); RAISE EXCEPTION 'FAIL other table allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%ORDER_NOT_PENDING%' THEN RAISE; END IF; END;

  -- Unchanged path: paid pending.
  v := public.reserve_order_refund('shop_orders', LIVE, 'paystack', 10, 0, 10, NULL, NULL, NULL, 0);
  IF v->>'refund_id' IS NULL THEN RAISE EXCEPTION 'FAIL pending path'; END IF;

  -- Privileges.
  IF has_function_privilege('anon', 'public.reserve_order_refund(' || ARGS || ')', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL anon reserve'; END IF;
  IF has_function_privilege('authenticated', 'public.late_paid_shop_order_ids(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL authenticated list'; END IF;
  IF NOT has_function_privilege('service_role', 'public.late_paid_shop_order_ids(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL service list'; END IF;

  RAISE NOTICE 'SELFTEST_OK';
END $selftest$;
