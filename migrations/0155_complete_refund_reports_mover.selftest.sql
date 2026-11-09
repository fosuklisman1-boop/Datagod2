-- 0155_complete_refund_reports_mover.selftest.sql
--
-- NOT A MIGRATION. Local PGlite selftest (psql-only, no real database touched). Run from the repo root with a
-- runner that expands `\i` (see memory reference-pglite-sql-tests). PASSES when it prints 'SELFTEST_OK'.
--
-- Scenarios: the first complete returns 'completed' and moves the refund and the order; a repeat returns
-- 'already_completed' and changes nothing; a compensated refund still returns 'failed'; bills flip payment_status;
-- a late-paid shop order (0154) completes through the real state-machine trigger; privileges; idempotent re-run.

DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $r$;

CREATE TABLE public.shop_orders (id uuid PRIMARY KEY, order_status varchar, payment_status varchar, updated_at timestamptz);
CREATE TABLE public.hubtel_bill_orders (id uuid PRIMARY KEY, status varchar, payment_status varchar, updated_at timestamptz);
CREATE TABLE public.order_refunds (
  id uuid PRIMARY KEY, order_table text, order_id uuid, status text, gateway_ref text, error text, completed_at timestamptz, updated_at timestamptz);

\i migrations/20260716_reversed_status_state_machine.sql
CREATE TRIGGER enforce_order_state_machine BEFORE UPDATE ON public.shop_orders FOR EACH ROW EXECUTE FUNCTION public.enforce_order_state_machine();

\i migrations/0155_complete_refund_reports_mover.sql
-- Re-run: must be idempotent.
\i migrations/0155_complete_refund_reports_mover.sql

DO $selftest$
DECLARE
  O1 uuid := gen_random_uuid(); R1 uuid := gen_random_uuid();
  O2 uuid := gen_random_uuid(); R2 uuid := gen_random_uuid();
  O3 uuid := gen_random_uuid(); R3 uuid := gen_random_uuid();
  v text; v_ref text; v_at timestamptz; v_at2 timestamptz;
BEGIN
  INSERT INTO public.shop_orders (id, order_status, payment_status) VALUES (O1, 'refunding', 'expired'), (O3, 'pending', 'completed');
  INSERT INTO public.hubtel_bill_orders (id, status, payment_status) VALUES (O2, 'refunding', 'paid');
  INSERT INTO public.order_refunds (id, order_table, order_id, status) VALUES
    (R1, 'shop_orders', O1, 'processing'), (R2, 'hubtel_bill_orders', O2, 'reserved'), (R3, 'shop_orders', O3, 'failed');

  v := public.complete_order_refund(R1, 'TX1');
  IF v <> 'completed' THEN RAISE EXCEPTION 'FAIL first: %', v; END IF;
  SELECT order_status INTO v FROM public.shop_orders WHERE id = O1;
  IF v <> 'refunded' THEN RAISE EXCEPTION 'FAIL order status: %', v; END IF;
  SELECT payment_status INTO v FROM public.shop_orders WHERE id = O1;
  IF v <> 'expired' THEN RAISE EXCEPTION 'FAIL shop payment_status touched: %', v; END IF;
  SELECT completed_at INTO v_at FROM public.order_refunds WHERE id = R1;

  v := public.complete_order_refund(R1, 'TX2');
  IF v <> 'already_completed' THEN RAISE EXCEPTION 'FAIL repeat: %', v; END IF;
  SELECT gateway_ref, completed_at INTO v_ref, v_at2 FROM public.order_refunds WHERE id = R1;
  IF v_ref <> 'TX1' OR v_at2 IS DISTINCT FROM v_at THEN RAISE EXCEPTION 'FAIL repeat changed the row: %', v_ref; END IF;

  v := public.complete_order_refund(R2, 'TX3');
  IF v <> 'completed' THEN RAISE EXCEPTION 'FAIL bill: %', v; END IF;
  SELECT payment_status INTO v FROM public.hubtel_bill_orders WHERE id = O2;
  IF v <> 'refunded' THEN RAISE EXCEPTION 'FAIL bill payment_status: %', v; END IF;

  v := public.complete_order_refund(R3, 'TX4');
  IF v <> 'failed' THEN RAISE EXCEPTION 'FAIL compensated: %', v; END IF;

  IF has_function_privilege('anon', 'public.complete_order_refund(uuid, text)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL anon'; END IF;
  IF has_function_privilege('authenticated', 'public.complete_order_refund(uuid, text)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL authenticated'; END IF;
  IF NOT has_function_privilege('service_role', 'public.complete_order_refund(uuid, text)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL service_role'; END IF;

  RAISE NOTICE 'SELFTEST_OK';
END $selftest$;
