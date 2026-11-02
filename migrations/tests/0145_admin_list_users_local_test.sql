-- LOCAL ONLY. Never run against production: it creates stub tables and an auth schema.
--
-- Exercises 0145_admin_list_users.sql against a stub schema in an EMPTY database,
-- with fixtures whose expected results are worked out by hand.
--
--   createdb users_test
--   psql -v ON_ERROR_STOP=1 -d users_test -f migrations/tests/0145_admin_list_users_local_test.sql
--
-- Passes when it prints ADMIN_LIST_USERS_LOCAL_TEST_OK. Any failed ASSERT aborts.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email varchar(255), created_at timestamptz, last_sign_in_at timestamptz);
CREATE TABLE users (id uuid PRIMARY KEY, email text, first_name text, last_name text, phone_number text,
  role varchar(20) DEFAULT 'user', is_suspended boolean DEFAULT false, pricing_mode text NOT NULL DEFAULT 'role');
CREATE TABLE user_shops (id uuid PRIMARY KEY, user_id uuid, shop_name varchar(255), shop_slug text,
  parent_shop_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE wallets (user_id uuid, balance numeric(12,2));
CREATE TABLE shop_available_balance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid UNIQUE,
  available_balance numeric(10,2) DEFAULT 0, total_profit numeric(10,2) DEFAULT 0, withdrawn_amount numeric(10,2) DEFAULT 0,
  pending_profit numeric(10,2) DEFAULT 0, credited_profit numeric(10,2) DEFAULT 0, withdrawn_profit numeric(10,2) DEFAULT 0,
  updated_at timestamptz DEFAULT now());
CREATE TABLE shop_customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid);
CREATE TABLE transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text, source text, status text, amount numeric);
CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status varchar(50));
CREATE TABLE shop_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, total_price numeric(10,2),
  order_status varchar(50), payment_status varchar(50));
CREATE TABLE shop_profits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid);
CREATE TABLE withdrawal_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, amount numeric, fee_amount numeric,
  net_amount numeric, status text, withdrawal_method text, created_at timestamptz, reference_code text);

-- A: shop owner (shop SA), custom pricing, 0244... phone, wallet 10, shop balance 7.5, 2 customers, 1 sub-agent (C)
-- B: suspended dealer, 233 phone, wallet 50, no shop, never signed in
-- C: sub-agent shop SC under SA, no wallet row, no shop balance row
-- D: auth user with NO public.users row (defaults), email has a literal % and _
-- E: admin, email 'eve_100%@x.com', created later
INSERT INTO auth.users VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Alice@Example.com', '2026-01-01 10:00+00', '2026-10-01 00:00+00'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com',   '2026-02-01 10:00+00', NULL),
  ('00000000-0000-0000-0000-00000000000c', 'carol@example.com', '2026-03-01 10:00+00', '2026-09-01 00:00+00'),
  ('00000000-0000-0000-0000-00000000000d', 'dan@plain.com',     '2026-03-01 10:00+00', '2026-08-01 00:00+00'),
  ('00000000-0000-0000-0000-00000000000e', 'eve_100%@x.com',    '2026-04-01 10:00+00', '2026-07-01 00:00+00');
INSERT INTO users (id, first_name, last_name, phone_number, role, is_suspended, pricing_mode) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Alice', 'A', '0244123456',   'user',   false, 'custom'),
  ('00000000-0000-0000-0000-00000000000b', 'Bob',   'B', '233201234567', 'dealer', true,  'role'),
  ('00000000-0000-0000-0000-00000000000c', 'Carol', 'C', '0551112222',   'sub_agent', false, 'role'),
  ('00000000-0000-0000-0000-00000000000e', 'Eve',   'E', NULL,           'admin',  false, 'role');
INSERT INTO user_shops (id, user_id, shop_name, shop_slug, parent_shop_id, created_at) VALUES
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Alpha Data Hub', 'alpha', NULL, '2026-01-02'),
  ('10000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000c', 'Carol Bundles',  'carol', '10000000-0000-0000-0000-00000000000a', '2026-03-02');
INSERT INTO wallets VALUES
  ('00000000-0000-0000-0000-00000000000a', 10.00),
  ('00000000-0000-0000-0000-00000000000b', 50.00),
  ('00000000-0000-0000-0000-00000000000d', 0.50),
  ('00000000-0000-0000-0000-00000000000e', 5.00);
INSERT INTO shop_available_balance (shop_id, available_balance, total_profit, pending_profit, credited_profit, withdrawn_profit) VALUES
  ('10000000-0000-0000-0000-00000000000a', 7.50, 20.00, 2.50, 7.50, 10.00);
INSERT INTO shop_customers (shop_id) VALUES
  ('10000000-0000-0000-0000-00000000000a'), ('10000000-0000-0000-0000-00000000000a'), ('10000000-0000-0000-0000-00000000000c');

-- Stats fixtures for A
INSERT INTO transactions (user_id, type, source, status, amount) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'credit', 'wallet_topup', 'completed', 30),
  ('00000000-0000-0000-0000-00000000000a', 'credit', 'wallet_topup', 'pending',   99),
  ('00000000-0000-0000-0000-00000000000a', 'credit', 'refund',       'completed',  4),
  ('00000000-0000-0000-0000-00000000000a', 'debit',  'purchase',     'completed', -12),
  ('00000000-0000-0000-0000-00000000000a', 'debit',  'purchase',     'success',    3),
  ('00000000-0000-0000-0000-00000000000a', 'debit',  'purchase',     'failed',     8);
INSERT INTO orders (user_id, status) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'completed'), ('00000000-0000-0000-0000-00000000000a', 'delivered'),
  ('00000000-0000-0000-0000-00000000000a', 'failed'),    ('00000000-0000-0000-0000-00000000000a', 'pending'),
  ('00000000-0000-0000-0000-00000000000a', 'processing');
INSERT INTO shop_orders (shop_id, total_price, order_status, payment_status) VALUES
  ('10000000-0000-0000-0000-00000000000a', 5.00, 'completed', 'completed'),
  ('10000000-0000-0000-0000-00000000000a', 7.00, 'delivered', 'completed'),
  ('10000000-0000-0000-0000-00000000000a', 9.00, 'pending',   'pending'),
  ('10000000-0000-0000-0000-00000000000c', 100,  'completed', 'completed');
INSERT INTO shop_profits (shop_id) VALUES ('10000000-0000-0000-0000-00000000000a'), ('10000000-0000-0000-0000-00000000000a');
INSERT INTO withdrawal_requests (user_id, amount, fee_amount, net_amount, status, withdrawal_method, created_at, reference_code) VALUES
  ('00000000-0000-0000-0000-00000000000a', 10, 1, 9, 'completed', 'mobile_money', '2026-05-01', 'W1'),
  ('00000000-0000-0000-0000-00000000000a',  6, 0, 6, 'approved',  'mobile_money', '2026-05-02', 'W2'),
  ('00000000-0000-0000-0000-00000000000a',  4, 0, 4, 'pending',   'mobile_money', '2026-05-03', 'W3'),
  ('00000000-0000-0000-0000-00000000000a',  3, 0, 3, 'rejected',  'mobile_money', '2026-05-04', 'W4');

\i migrations/0145_admin_list_users.sql
-- Idempotent: a second apply succeeds.
\i migrations/0145_admin_list_users.sql

CREATE FUNCTION pg_temp.ids(v jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(right(r->>'id', 1), '' ORDER BY ord), '')
  FROM jsonb_array_elements(v->'rows') WITH ORDINALITY AS t(r, ord)
$$;

CREATE FUNCTION pg_temp.l(
  q text DEFAULT NULL, role text DEFAULT NULL, susp boolean DEFAULT NULL, has_shop boolean DEFAULT NULL,
  pm text DEFAULT NULL, f timestamptz DEFAULT NULL, t timestamptz DEFAULT NULL,
  sort text DEFAULT 'created_at', dir text DEFAULT 'desc', lim int DEFAULT 50, off int DEFAULT 0
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.admin_list_users(q, role, susp, has_shop, pm, f, t, sort, dir, lim, off)
$$;

DO $$
DECLARE
  v jsonb;
  r jsonb;
  msg text;
BEGIN
  -- default: created_at desc, id desc tiebreak (C and D share created_at: d > c)
  v := pg_temp.l();
  ASSERT (v->>'total')::int = 5, format('total: %s', v->'total');
  ASSERT pg_temp.ids(v) = 'edcba', format('default order: %s', pg_temp.ids(v));
  ASSERT pg_temp.ids(pg_temp.l(dir => 'asc')) = 'abcde', 'created_at asc + id asc tiebreak';

  -- row shape and joined values for A
  SELECT x INTO r FROM jsonb_array_elements(v->'rows') x WHERE x->>'id' LIKE '%a';
  ASSERT r->>'email' = 'Alice@Example.com' AND r->>'phone_number' = '0244123456', format('A: %s', r);
  ASSERT r->>'first_name' = 'Alice' AND r->>'role' = 'user' AND r->>'pricing_mode' = 'custom', format('A: %s', r);
  ASSERT (r->>'wallet_balance')::numeric = 10 AND (r->>'shop_balance')::numeric = 7.5, format('A balances: %s', r);
  ASSERT r->>'shop_name' = 'Alpha Data Hub' AND r->>'shop_id' = '10000000-0000-0000-0000-00000000000a', format('A shop: %s', r);
  ASSERT (r->>'customer_count')::int = 2 AND (r->>'sub_agent_count')::int = 1, format('A counts: %s', r);
  ASSERT r ? 'last_sign_in_at' AND r ? 'created_at' AND r ? 'shop_created_at' AND r ? 'is_suspended', 'A keys';

  -- C: shop but no wallet / no balance row => zeros
  SELECT x INTO r FROM jsonb_array_elements(v->'rows') x WHERE x->>'id' LIKE '%c';
  ASSERT (r->>'wallet_balance')::numeric = 0 AND (r->>'shop_balance')::numeric = 0, format('C: %s', r);
  ASSERT (r->>'customer_count')::int = 1 AND (r->>'sub_agent_count')::int = 0, format('C counts: %s', r);

  -- D: no profile row => defaults
  SELECT x INTO r FROM jsonb_array_elements(v->'rows') x WHERE x->>'id' LIKE '%d';
  ASSERT r->>'role' = 'user' AND (r->>'is_suspended')::boolean = false AND r->>'pricing_mode' = 'role'
     AND r->'phone_number' = 'null'::jsonb AND r->'shop_id' = 'null'::jsonb, format('D: %s', r);
  ASSERT (r->>'customer_count')::int = 0 AND (r->>'sub_agent_count')::int = 0, 'D counts';

  -- filters
  ASSERT pg_temp.ids(pg_temp.l(role => 'dealer')) = 'b', 'role dealer';
  ASSERT pg_temp.ids(pg_temp.l(role => 'user')) = 'da', 'role user includes no-profile user';
  ASSERT pg_temp.ids(pg_temp.l(susp => true)) = 'b', 'suspended';
  ASSERT pg_temp.ids(pg_temp.l(susp => false)) = 'edca', 'not suspended';
  ASSERT pg_temp.ids(pg_temp.l(has_shop => true)) = 'ca', 'has shop';
  ASSERT pg_temp.ids(pg_temp.l(has_shop => false)) = 'edb', 'no shop';
  ASSERT pg_temp.ids(pg_temp.l(pm => 'custom')) = 'a', 'custom pricing';
  ASSERT pg_temp.ids(pg_temp.l(f => '2026-02-01 10:00+00', t => '2026-04-01 10:00+00')) = 'dcb', 'from inclusive, to exclusive';
  ASSERT pg_temp.ids(pg_temp.l(role => 'user', has_shop => true)) = 'a', 'combined filters';

  -- search: case-insensitive, email / phone / shop name
  ASSERT pg_temp.ids(pg_temp.l(q => 'ALICE')) = 'a', 'email ci';
  ASSERT pg_temp.ids(pg_temp.l(q => 'data hub')) = 'a', 'shop name';
  ASSERT pg_temp.ids(pg_temp.l(q => '  bundles ')) = 'c', 'trimmed shop name';
  ASSERT pg_temp.ids(pg_temp.l(q => 'example.com')) = 'cba', 'email substring';
  -- wildcards are literal
  ASSERT pg_temp.ids(pg_temp.l(q => '%')) = 'e', format('percent literal: %s', pg_temp.ids(pg_temp.l(q => '%')));
  ASSERT pg_temp.ids(pg_temp.l(q => '_')) = 'e', 'underscore literal';
  ASSERT pg_temp.ids(pg_temp.l(q => 'e_1')) = 'e', 'underscore inside term';
  ASSERT pg_temp.ids(pg_temp.l(q => 'a_ice')) = '', 'underscore is not a wildcard';
  ASSERT pg_temp.ids(pg_temp.l(q => '\')) = '', 'backslash literal';
  -- Ghana phone formats both ways
  ASSERT pg_temp.ids(pg_temp.l(q => '233244123456')) = 'a', '233 form finds 0 form';
  ASSERT pg_temp.ids(pg_temp.l(q => '+233 24 412 3456')) = 'a', '+233 spaced form';
  ASSERT pg_temp.ids(pg_temp.l(q => '0201234567')) = 'b', '0 form finds 233 form';
  ASSERT pg_temp.ids(pg_temp.l(q => '020')) = 'b', 'partial 0 prefix is anchored';
  ASSERT pg_temp.ids(pg_temp.l(q => '0244')) = 'a', 'partial 0244';
  ASSERT pg_temp.ids(pg_temp.l(q => '1112222')) = 'c', 'bare digits match anywhere';
  ASSERT pg_temp.ids(pg_temp.l(q => 'nobody')) = '' AND (pg_temp.l(q => 'nobody')->>'total')::int = 0, 'no match';
  ASSERT pg_temp.l(q => 'nobody')->'rows' = '[]'::jsonb, 'empty rows is []';

  -- sorts
  ASSERT pg_temp.ids(pg_temp.l(sort => 'balance')) = 'baedc', format('wallet balance desc (c,d tie? no): %s', pg_temp.ids(pg_temp.l(sort => 'balance')));
  ASSERT pg_temp.ids(pg_temp.l(sort => 'balance', dir => 'asc')) = 'cdeab', 'wallet balance asc';
  ASSERT pg_temp.ids(pg_temp.l(sort => 'shop_balance')) = 'aedcb', 'shop balance desc, ties by id desc';
  ASSERT pg_temp.ids(pg_temp.l(sort => 'shop_balance', dir => 'asc')) = 'bcdea', 'shop balance asc, ties by id asc';
  ASSERT pg_temp.ids(pg_temp.l(sort => 'email', dir => 'asc')) = 'abcde', 'email asc, case-insensitive';
  ASSERT pg_temp.ids(pg_temp.l(sort => 'last_sign_in_at')) = 'acdeb', 'last sign in desc, never last';
  ASSERT pg_temp.ids(pg_temp.l(sort => 'last_sign_in_at', dir => 'asc')) = 'edcab', 'last sign in asc, never last';
  ASSERT pg_temp.ids(pg_temp.l(sort => ' EMAIL ', dir => 'ASC')) = 'abcde', 'sort/dir normalised';

  -- paging + clamping
  v := pg_temp.l(lim => 2, off => 0);
  ASSERT pg_temp.ids(v) = 'ed' AND (v->>'total')::int = 5, 'page 1';
  ASSERT pg_temp.ids(pg_temp.l(lim => 2, off => 2)) = 'cb', 'page 2';
  ASSERT pg_temp.ids(pg_temp.l(lim => 2, off => 4)) = 'a', 'page 3';
  v := pg_temp.l(lim => 2, off => 10);
  ASSERT pg_temp.ids(v) = '' AND (v->>'total')::int = 5, 'past the end still has total';
  ASSERT pg_temp.ids(pg_temp.l(lim => 0)) = 'e', 'limit 0 clamps to 1';
  ASSERT pg_temp.ids(pg_temp.l(lim => -5)) = 'e', 'negative limit clamps to 1';
  ASSERT pg_temp.ids(pg_temp.l(lim => 100000)) = 'edcba', 'huge limit clamps to 200';
  ASSERT pg_temp.ids(pg_temp.l(lim => NULL, off => -3)) = 'edcba', 'null limit, negative offset';

  -- bad input
  BEGIN
    PERFORM pg_temp.l(sort => 'id; drop table users');
    RAISE EXCEPTION 'bad sort accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'BAD_INPUT', msg;
  END;
  BEGIN
    PERFORM pg_temp.l(dir => 'sideways');
    RAISE EXCEPTION 'bad dir accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'BAD_INPUT', msg;
  END;
  BEGIN
    PERFORM pg_temp.l(pm => 'free');
    RAISE EXCEPTION 'bad pricing mode accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'BAD_INPUT', msg;
  END;

  -- grants
  ASSERT NOT has_function_privilege('anon', 'public.admin_list_users(text,text,boolean,boolean,text,timestamptz,timestamptz,text,text,int,int)', 'EXECUTE'), 'anon list';
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_list_users(text,text,boolean,boolean,text,timestamptz,timestamptz,text,text,int,int)', 'EXECUTE'), 'authenticated list';
  ASSERT has_function_privilege('service_role', 'public.admin_list_users(text,text,boolean,boolean,text,timestamptz,timestamptz,text,text,int,int)', 'EXECUTE'), 'service_role list';
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_user_stats(uuid)', 'EXECUTE'), 'authenticated stats';
  ASSERT NOT has_function_privilege('anon', 'public.admin_user_stats(uuid)', 'EXECUTE'), 'anon stats';
  ASSERT has_function_privilege('service_role', 'public.admin_user_stats(uuid)', 'EXECUTE'), 'service_role stats';

  -- stats for A, by hand
  v := public.admin_user_stats('00000000-0000-0000-0000-00000000000a');
  ASSERT v->>'userId' = '00000000-0000-0000-0000-00000000000a', 'userId';
  ASSERT v->'wallet' = '{"balance": 10.00, "totalTopUps": 30, "totalSpent": 15, "transactionCount": 6}'::jsonb, format('wallet: %s', v->'wallet');
  ASSERT v->'orders' = '{"total": 5, "completed": 2, "failed": 1, "pending": 2}'::jsonb, format('orders: %s', v->'orders');
  ASSERT (v->'shop'->>'totalOrders')::int = 3 AND (v->'shop'->>'paidOrders')::int = 2 AND (v->'shop'->>'completedOrders')::int = 2, format('shop counts: %s', v->'shop');
  ASSERT (v->'shop'->>'totalSales')::numeric = 12 AND (v->'shop'->>'profitRecords')::int = 2, format('shop sales: %s', v->'shop');
  ASSERT (v->'shop'->>'availableBalance')::numeric = 7.5 AND (v->'shop'->>'withdrawnAmount')::numeric = 10
     AND (v->'shop'->>'totalProfit')::numeric = 20 AND (v->'shop'->>'pendingProfit')::numeric = 2.5
     AND (v->'shop'->>'creditedProfit')::numeric = 7.5, format('shop balance: %s', v->'shop');
  ASSERT v->'shop'->>'shopName' = 'Alpha Data Hub' AND v->'shop'->>'shopSlug' = 'alpha', 'shop name/slug';
  ASSERT (v->'withdrawals'->>'totalWithdrawn')::numeric = 15 AND (v->'withdrawals'->>'pendingCount')::int = 1
     AND (v->'withdrawals'->>'completedCount')::int = 2, format('withdrawals: %s', v->'withdrawals');
  ASSERT jsonb_array_length(v->'withdrawals'->'history') = 4 AND v->'withdrawals'->'history'->0->>'referenceCode' = 'W4'
     AND v->'withdrawals'->'history'->0 ?& ARRAY['id','amount','feeAmount','netAmount','status','method','createdAt','referenceCode'], 'history';

  -- user without shop, wallet, or anything
  v := public.admin_user_stats('00000000-0000-0000-0000-00000000000d');
  ASSERT v->'shop' = 'null'::jsonb AND (v->'wallet'->>'balance')::numeric = 0.5, format('D stats: %s', v);
  ASSERT v->'orders' = '{"total": 0, "completed": 0, "failed": 0, "pending": 0}'::jsonb, 'D orders';
  ASSERT v->'withdrawals' = '{"totalWithdrawn": 0, "pendingCount": 0, "completedCount": 0, "history": []}'::jsonb, format('D withdrawals: %s', v->'withdrawals');

  RAISE NOTICE 'ADMIN_LIST_USERS_LOCAL_TEST_OK';
END $$;
