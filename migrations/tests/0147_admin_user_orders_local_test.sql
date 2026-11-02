-- LOCAL ONLY. Never run against production: it creates stub tables.
--
-- Exercises 0147_admin_user_orders.sql against a stub schema in an EMPTY database. Run from the repo root:
--
--   createdb user_orders_test
--   psql -v ON_ERROR_STOP=1 -d user_orders_test -f migrations/tests/0147_admin_user_orders_local_test.sql
--
-- Passes when it prints ADMIN_USER_ORDERS_LOCAL_TEST_OK. Any failed ASSERT aborts.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Column names and types as in the migrations that create these tables (orders / api_orders as the app
-- selects them; orders.created_at is timestamp without time zone, as in some environments).
CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, network varchar(20), size varchar(20),
  phone_number varchar(20), price numeric(10,2), status varchar(50), created_at timestamp);
CREATE TABLE public.api_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, network text, volume_gb numeric,
  recipient_phone text, price numeric, status text, created_at timestamptz);
CREATE TABLE public.hubtel_data_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference_code text, user_id uuid NOT NULL,
  network text, bundle_display text, beneficiary_phone text, amount numeric(12,2), status text, payment_status text, created_at timestamptz);
CREATE TABLE public.airtime_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, reference_code text,
  network text, beneficiary_phone text, airtime_amount numeric(10,2), total_paid numeric(10,2), status text, created_at timestamptz);
CREATE TABLE public.hubtel_bill_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference_code text, user_id uuid NOT NULL,
  biller text, account_number text, amount numeric(12,2), status text, payment_status text, created_at timestamptz);
CREATE TABLE public.results_checker_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, reference_code text,
  exam_board text, quantity integer, customer_phone text, total_paid numeric(10,2), status text, payment_status text, created_at timestamptz);
CREATE TABLE public.afa_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, order_code varchar(50),
  full_name varchar(255), phone_number varchar(20), amount decimal(10,2), status varchar(50), created_at timestamptz);

-- User U: one order per source on consecutive days (data oldest .. afa newest), plus a second, FAILED data order
-- that is the newest of all. User V has one order that must never show up for U.
INSERT INTO public.orders (id, user_id, network, size, phone_number, price, status, created_at) VALUES
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'MTN', '5', '0244000001', 25.00, 'completed', '2026-10-01 10:00'),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'AT',  '2', '0277000001', 9.50,  'FAILED',    '2026-10-09 10:00'),
  ('a0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000b', 'MTN', '1', '0244999999', 5.00,  'completed', '2026-10-05 10:00');
INSERT INTO public.api_orders (id, user_id, network, volume_gb, recipient_phone, price, status, created_at) VALUES
  ('b0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'MTN', 10, '0244000002', 45, 'pending', '2026-10-02 10:00+00');
INSERT INTO public.hubtel_data_orders (id, reference_code, user_id, network, bundle_display, beneficiary_phone, amount, status, payment_status, created_at) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'SB-1', '00000000-0000-0000-0000-00000000000a', 'TELECEL', '3GB', '0200000003', 15, 'completed', 'paid', '2026-10-03 10:00+00');
INSERT INTO public.airtime_orders (id, user_id, reference_code, network, beneficiary_phone, airtime_amount, total_paid, status, created_at) VALUES
  ('d0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'AT-1', 'MTN', '0244000004', 10, 10.20, 'failed', '2026-10-04 10:00+00');
INSERT INTO public.hubtel_bill_orders (id, reference_code, user_id, biller, account_number, amount, status, payment_status, created_at) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'BL-1', '00000000-0000-0000-0000-00000000000a', 'ecg', 'ACC-5', 100, 'refunded', 'refunded', '2026-10-05 10:00+00');
INSERT INTO public.results_checker_orders (id, user_id, reference_code, exam_board, quantity, customer_phone, total_paid, status, payment_status, created_at) VALUES
  ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'RC-1', 'WAEC', 2, '0244000006', 40, 'pending_payment', 'pending_payment', '2026-10-06 10:00+00'),
  ('f0000000-0000-0000-0000-000000000002', NULL, 'RC-G', 'BECE', 1, '0244000066', 20, 'completed', 'completed', '2026-10-06 11:00+00');
INSERT INTO public.afa_orders (id, user_id, order_code, full_name, phone_number, amount, status, created_at) VALUES
  ('90000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'AFA-1', 'Ama Mensah', '0244000007', 30, 'cancelled', '2026-10-07 10:00+00');

-- User W: 1,003 data orders (over the 1,000 count cap) and 2 airtime orders, several sharing a created_at.
INSERT INTO public.orders (user_id, network, size, phone_number, price, status, created_at)
SELECT '00000000-0000-0000-0000-0000000000cc', 'MTN', '1', '0244', 1, 'completed', timestamp '2026-01-01' + (g / 3) * interval '1 minute'
FROM generate_series(1, 1003) g;
INSERT INTO public.airtime_orders (user_id, reference_code, network, beneficiary_phone, airtime_amount, total_paid, status, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000cc', 'AT-W1', 'MTN', '0244', 1, 1, 'completed', '2026-01-01 05:34+00'),
  ('00000000-0000-0000-0000-0000000000cc', 'AT-W2', 'MTN', '0244', 1, 1, 'completed', '2030-01-01 00:00+00');

\i migrations/0147_admin_user_orders.sql
\i migrations/0147_admin_user_orders.sql

SET TIME ZONE 'UTC';

DO $$
DECLARE
  U constant uuid := '00000000-0000-0000-0000-00000000000a';
  r jsonb;
  v_err text;
BEGIN
  -- All sources, newest first.
  r := public.admin_user_orders(U, NULL, NULL, 20, 0);
  ASSERT (r->>'total')::int = 8, r->>'total';
  ASSERT r->'counts' = '{"data":2,"api":1,"standard":1,"airtime":1,"bills":1,"results":1,"afa":1}'::jsonb, r->>'counts';
  ASSERT r->'capped_sources' = '[]'::jsonb AND (r->>'total_capped')::boolean = false AND (r->>'count_cap')::int = 1000, r::text;
  ASSERT (r->>'has_more')::boolean = false, r::text;
  ASSERT (SELECT string_agg(e->>'source', ',' ORDER BY o) FROM jsonb_array_elements(r->'rows') WITH ORDINALITY x(e, o))
         = 'data,afa,results,bills,airtime,standard,api,data',
         (SELECT string_agg(e->>'source', ',' ORDER BY o) FROM jsonb_array_elements(r->'rows') WITH ORDINALITY x(e, o));

  -- Normalised row shapes.
  ASSERT r->'rows'->0 @> '{"source":"data","description":"AT 2","recipient":"0277000001","amount":9.50,"status":"FAILED"}'::jsonb, r->'rows'->>0;
  ASSERT r->'rows'->0->'reference' = 'null'::jsonb, r->'rows'->>0;
  -- payment_status: the table's own column where it has one (NULL for wallet-paid tables).
  ASSERT r->'rows'->0->'payment_status' = 'null'::jsonb, r->'rows'->>0;
  ASSERT r->'rows'->2->>'payment_status' = 'pending_payment', r->'rows'->>2;
  ASSERT r->'rows'->5->>'payment_status' = 'paid', r->'rows'->>5;
  ASSERT r->'rows'->1 @> '{"source":"afa","reference":"AFA-1","description":"AFA Ama Mensah","amount":30.00}'::jsonb, r->'rows'->>1;
  ASSERT r->'rows'->2 @> '{"source":"results","reference":"RC-1","description":"WAEC x2","recipient":"0244000006"}'::jsonb, r->'rows'->>2;
  ASSERT r->'rows'->3 @> '{"source":"bills","reference":"BL-1","description":"ecg","recipient":"ACC-5"}'::jsonb, r->'rows'->>3;
  ASSERT r->'rows'->4 @> '{"source":"airtime","description":"MTN airtime 10.00","amount":10.20}'::jsonb, r->'rows'->>4;
  ASSERT r->'rows'->5 @> '{"source":"standard","reference":"SB-1","description":"TELECEL 3GB"}'::jsonb, r->'rows'->>5;
  ASSERT r->'rows'->6 @> '{"source":"api","description":"MTN 10GB","amount":45}'::jsonb, r->'rows'->>6;
  ASSERT (r->'rows'->7->>'created_at')::timestamptz = '2026-10-01 10:00+00', r->'rows'->7->>'created_at';

  -- Paging: limit/offset over the merged, ordered list.
  r := public.admin_user_orders(U, NULL, NULL, 3, 3);
  ASSERT (r->>'total')::int = 8 AND jsonb_array_length(r->'rows') = 3, r::text;
  ASSERT r->'rows'->0->>'source' = 'bills' AND r->'rows'->2->>'source' = 'standard', r::text;
  ASSERT (r->>'has_more')::boolean, 'rows 7-8 remain';
  ASSERT NOT (public.admin_user_orders(U, NULL, NULL, 3, 5)->>'has_more')::boolean, 'last page';
  r := public.admin_user_orders(U, NULL, NULL, 20, 100);
  ASSERT (r->>'total')::int = 8 AND r->'rows' = '[]'::jsonb, 'past the end keeps the total';
  -- Clamping: limit 0 -> 1, limit 1000 -> 100, NULL -> 20, negative offset -> 0.
  ASSERT jsonb_array_length(public.admin_user_orders(U, NULL, NULL, 0, 0)->'rows') = 1;
  ASSERT jsonb_array_length(public.admin_user_orders(U, NULL, NULL, NULL, -5)->'rows') = 8;
  ASSERT jsonb_array_length(public.admin_user_orders(U, NULL, NULL, 1000, NULL)->'rows') = 8;

  -- Source filter: total is that source's count; counts still cover every source.
  r := public.admin_user_orders(U, 'data', NULL, 20, 0);
  ASSERT (r->>'total')::int = 2 AND jsonb_array_length(r->'rows') = 2, r::text;
  ASSERT (r->'counts'->>'afa')::int = 1, r->>'counts';
  ASSERT public.admin_user_orders(U, ' AFA ', NULL, 20, 0)->'rows'->0->>'source' = 'afa', 'source is trimmed and case-insensitive';

  -- Status filter: case-insensitive exact match, applied to counts too.
  r := public.admin_user_orders(U, NULL, 'failed', 20, 0);
  ASSERT (r->>'total')::int = 2, r::text;
  ASSERT r->'counts' = '{"data":1,"airtime":1}'::jsonb, r->>'counts';
  r := public.admin_user_orders(U, 'airtime', 'Failed', 20, 0);
  ASSERT (r->>'total')::int = 1 AND r->'rows'->0->>'source' = 'airtime', r::text;
  r := public.admin_user_orders(U, NULL, 'fail', 20, 0);
  ASSERT (r->>'total')::int = 0 AND r->'counts' = '{}'::jsonb AND r->'rows' = '[]'::jsonb, 'no substring match';
  r := public.admin_user_orders(U, NULL, 'pending_payment', 20, 0);
  ASSERT (r->>'total')::int = 1 AND r->'rows'->0->>'source' = 'results', r::text;

  -- Other users' and guest orders never show up.
  ASSERT NOT (public.admin_user_orders(U, NULL, NULL, 100, 0)::text LIKE '%0244999999%'), 'leaked user B';
  ASSERT NOT (public.admin_user_orders(U, NULL, NULL, 100, 0)::text LIKE '%RC-G%'), 'leaked guest order';
  r := public.admin_user_orders('00000000-0000-0000-0000-0000000000ff', NULL, NULL, 20, 0);
  ASSERT (r->>'total')::int = 0 AND r->'rows' = '[]'::jsonb AND r->'counts' = '{}'::jsonb, r::text;

  -- Over the count cap: counts stop at 1000 and say so; paging still works by has_more.
  r := public.admin_user_orders('00000000-0000-0000-0000-0000000000cc', NULL, NULL, 20, 0);
  ASSERT r->'counts' = '{"data":1000,"airtime":2}'::jsonb, r->>'counts';
  ASSERT r->'capped_sources' = '["data"]'::jsonb AND (r->>'total_capped')::boolean AND (r->>'total')::int = 1002, r::text;
  ASSERT (r->>'has_more')::boolean, r::text;
  ASSERT r->'rows'->0->>'reference' = 'AT-W2', 'newest first across tables';
  r := public.admin_user_orders('00000000-0000-0000-0000-0000000000cc', 'airtime', NULL, 20, 0);
  ASSERT (r->>'total')::int = 2 AND NOT (r->>'total_capped')::boolean AND NOT (r->>'has_more')::boolean, r::text;
  -- Merged paging equals a full sort of everything (ties on created_at broken by id, no row twice or skipped).
  DECLARE
    v_all text := '';
    v_page jsonb;
    v_expected text;
  BEGIN
    FOR i IN 0..55 LOOP
      v_page := public.admin_user_orders('00000000-0000-0000-0000-0000000000cc', NULL, NULL, 19, i * 19)->'rows';
      SELECT v_all || coalesce(string_agg(e->>'id', ',' ORDER BY o), '') || ',' INTO v_all
      FROM jsonb_array_elements(v_page) WITH ORDINALITY x(e, o);
    END LOOP;
    SELECT string_agg(id::text, ',' ORDER BY ts DESC, id DESC) INTO v_expected FROM (
      SELECT id, created_at::timestamptz AS ts FROM public.orders WHERE user_id = '00000000-0000-0000-0000-0000000000cc'
      UNION ALL SELECT id, created_at FROM public.airtime_orders WHERE user_id = '00000000-0000-0000-0000-0000000000cc'
    ) z;
    ASSERT regexp_replace(v_all, ',+', ',', 'g') = v_expected || ',', 'paged walk differs from a full sort';
  END;

  -- Errors.
  BEGIN
    PERFORM public.admin_user_orders(U, 'shop', NULL, 20, 0);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  ASSERT v_err = 'BAD_INPUT', coalesce(v_err, 'no error for unknown source');
  v_err := NULL;
  BEGIN
    PERFORM public.admin_user_orders(NULL, NULL, NULL, 20, 0);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  ASSERT v_err = 'BAD_INPUT', coalesce(v_err, 'no error for null user');

  -- Grants and definition.
  ASSERT NOT has_function_privilege('anon',          'public.admin_user_orders(uuid,text,text,int,int)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_user_orders(uuid,text,text,int,int)', 'EXECUTE');
  ASSERT has_function_privilege('service_role',      'public.admin_user_orders(uuid,text,text,int,int)', 'EXECUTE');
  ASSERT (SELECT prosecdef FROM pg_proc WHERE proname = 'admin_user_orders'), 'not SECURITY DEFINER';
END $$;

-- service_role calls it through the definer even though it has no rights on the tables or the helper.
SET ROLE service_role;
SELECT (public.admin_user_orders('00000000-0000-0000-0000-00000000000a', NULL, NULL, 20, 0))->>'total' AS service_role_total;
RESET ROLE;

SELECT 'ADMIN_USER_ORDERS_LOCAL_TEST_OK' AS result;
