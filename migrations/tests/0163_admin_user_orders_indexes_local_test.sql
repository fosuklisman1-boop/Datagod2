-- LOCAL ONLY. Never run against production: it creates stub tables with generated rows.
-- Renamed from 0148_admin_user_orders_indexes_local_test.sql. The migration it tests was already applied to production on 2026-11-09 (as 0148_admin_user_orders_indexes.sql).
--
-- Applies 0162 and 0163 to a stub schema with one heavy user (200k data orders) and checks that
-- admin_user_orders reads the new (user_id, created_at DESC) indexes as top-N scans and stays fast.
-- Run from the repo root, in autocommit mode (0163 uses CREATE INDEX CONCURRENTLY):
--
--   createdb user_orders_idx_test
--   psql -v ON_ERROR_STOP=1 -d user_orders_idx_test -f migrations/tests/0163_admin_user_orders_indexes_local_test.sql
--
-- Passes when it prints ADMIN_USER_ORDERS_INDEXES_LOCAL_TEST_OK.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, network varchar(20), size varchar(20),
  phone_number varchar(20), price numeric(10,2), status varchar(50), created_at timestamp);
CREATE TABLE public.api_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, network text, volume_gb numeric,
  recipient_phone text, price numeric, status text, created_at timestamptz);
CREATE TABLE public.hubtel_data_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference_code text, user_id uuid NOT NULL,
  network text, bundle_display text, beneficiary_phone text, amount numeric(12,2), status text, payment_status text, created_at timestamptz);
CREATE INDEX hubtel_data_orders_user_idx ON public.hubtel_data_orders (user_id, created_at DESC);
CREATE TABLE public.airtime_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, reference_code text,
  network text, beneficiary_phone text, airtime_amount numeric(10,2), total_paid numeric(10,2), status text, created_at timestamptz);
CREATE TABLE public.hubtel_bill_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference_code text, user_id uuid NOT NULL,
  biller text, account_number text, amount numeric(12,2), status text, payment_status text, created_at timestamptz);
CREATE INDEX hubtel_bill_orders_user_idx ON public.hubtel_bill_orders (user_id, created_at DESC);
CREATE TABLE public.results_checker_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, reference_code text,
  exam_board text, quantity integer, customer_phone text, total_paid numeric(10,2), status text, payment_status text, created_at timestamptz);
CREATE TABLE public.afa_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, order_code varchar(50),
  full_name varchar(255), phone_number varchar(20), amount decimal(10,2), status varchar(50), created_at timestamptz);
-- The existing single-column user_id indexes.
CREATE INDEX idx_orders_user_id ON public.orders (user_id);
CREATE INDEX idx_airtime_orders_user_id ON public.airtime_orders (user_id);

-- Heavy user H: 200k data orders, 20k airtime orders; 100 other users with 1k data orders each.
INSERT INTO public.orders (user_id, network, size, phone_number, price, status, created_at)
SELECT '00000000-0000-0000-0000-0000000000ff', 'MTN', '1', '0244', 1, CASE WHEN g % 10 = 0 THEN 'failed' ELSE 'completed' END,
       timestamp '2025-01-01' + g * interval '1 minute'
FROM generate_series(1, 200000) g;
INSERT INTO public.orders (user_id, network, size, phone_number, price, status, created_at)
SELECT ('00000000-0000-0000-0000-' || lpad(to_hex(u), 12, '0'))::uuid, 'AT', '2', '0277', 2, 'completed',
       timestamp '2025-01-01' + g * interval '1 hour'
FROM generate_series(1, 100) u, generate_series(1, 1000) g;
INSERT INTO public.airtime_orders (user_id, reference_code, network, beneficiary_phone, airtime_amount, total_paid, status, created_at)
SELECT '00000000-0000-0000-0000-0000000000ff', 'AT-' || g, 'MTN', '0244', 1, 1, 'completed', timestamptz '2025-01-01' + g * interval '7 minutes'
FROM generate_series(1, 20000) g;

\i migrations/0162_admin_user_orders.sql
\i migrations/0163_admin_user_orders_indexes.sql
\i migrations/0163_admin_user_orders_indexes.sql
ANALYZE;

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname LIKE 'idx\_%\_user\_created\_at' AND i.indisvalid;
  ASSERT n = 5, format('expected 5 valid indexes, found %s', n);
END $$;

-- The data branch, exactly as admin_user_orders runs it, must be a top-N read of the new index.
DO $$
DECLARE
  v_plan text := '';
  l text;
BEGIN
  FOR l IN EXECUTE $q$
    EXPLAIN (COSTS OFF)
    SELECT o.id FROM public.orders o
    WHERE o.user_id = '00000000-0000-0000-0000-0000000000ff' AND (NULL::text IS NULL OR lower(o.status) = NULL::text)
    ORDER BY o.created_at DESC, o.id DESC LIMIT 41 $q$
  LOOP
    v_plan := v_plan || l || E'\n';
  END LOOP;
  RAISE NOTICE '%', v_plan;
  ASSERT v_plan LIKE '%idx_orders_user_created_at%', 'data branch does not use idx_orders_user_created_at';
  ASSERT v_plan NOT LIKE '%Seq Scan%', 'data branch seq-scans';
END $$;

\echo '--- EXPLAIN ANALYZE: heavy user, page 1, all sources'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT public.admin_user_orders('00000000-0000-0000-0000-0000000000ff', NULL, NULL, 20, 0);
\echo '--- EXPLAIN ANALYZE: heavy user, page 50, status failed'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT public.admin_user_orders('00000000-0000-0000-0000-0000000000ff', NULL, 'failed', 20, 980);

-- Timing guard: a page for the 220k-order user must be far below the old ~0.5 s (generous for slow CI).
DO $$
DECLARE
  t0 timestamptz;
  ms numeric;
  r jsonb;
BEGIN
  PERFORM public.admin_user_orders('00000000-0000-0000-0000-0000000000ff', NULL, NULL, 20, 0);  -- warm
  t0 := clock_timestamp();
  FOR i IN 1..10 LOOP
    r := public.admin_user_orders('00000000-0000-0000-0000-0000000000ff', NULL, NULL, 20, 0);
  END LOOP;
  ms := extract(epoch FROM clock_timestamp() - t0) * 1000 / 10;
  RAISE NOTICE 'admin_user_orders heavy user, page 1: % ms per call', round(ms, 2);
  ASSERT r->'counts' = '{"data":1000,"airtime":1000}'::jsonb, r->>'counts';
  ASSERT (r->>'total_capped')::boolean AND (r->>'has_more')::boolean, r::text;
  ASSERT jsonb_array_length(r->'rows') = 20, r::text;
  ASSERT ms < 100, format('too slow: %s ms', ms);
END $$;

SELECT 'ADMIN_USER_ORDERS_INDEXES_LOCAL_TEST_OK' AS result;
