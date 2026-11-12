-- LOCAL ONLY. Never run against production: it creates stub tables and an auth schema.
-- Renamed from 0145_admin_list_users_local_test.sql. The migration it tests was already applied to production on 2026-11-09 (as 0145_admin_list_users.sql).
--
-- Exercises 0170_admin_list_users.sql against a stub schema in an EMPTY database,
-- with fixtures whose expected results are worked out by hand.
--
--   createdb users_test
--   psql -v ON_ERROR_STOP=1 -d users_test -f migrations/tests/0170_admin_list_users_local_test.sql
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
-- F: TWO wallet rows (3.00 and 4.00), role '' (treated as 'user'), oldest signup, no shop
INSERT INTO auth.users VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Alice@Example.com', '2026-01-01 10:00+00', '2026-10-01 00:00+00'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com',   '2026-02-01 10:00+00', NULL),
  ('00000000-0000-0000-0000-00000000000c', 'carol@example.com', '2026-03-01 10:00+00', '2026-09-01 00:00+00'),
  ('00000000-0000-0000-0000-00000000000d', 'dan@plain.com',     '2026-03-01 10:00+00', '2026-08-01 00:00+00'),
  ('00000000-0000-0000-0000-00000000000e', 'eve_100%@x.com',    '2026-04-01 10:00+00', '2026-07-01 00:00+00'),
  ('00000000-0000-0000-0000-00000000000f', 'frank@two.com',     '2025-12-01 10:00+00', '2026-06-01 00:00+00');
INSERT INTO users (id, first_name, last_name, phone_number, role, is_suspended, pricing_mode) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Alice', 'A', '0244123456',   'user',   false, 'custom'),
  ('00000000-0000-0000-0000-00000000000b', 'Bob',   'B', '233201234567', 'dealer', true,  'role'),
  ('00000000-0000-0000-0000-00000000000c', 'Carol', 'C', '0551112222',   'sub_agent', false, 'role'),
  ('00000000-0000-0000-0000-00000000000e', 'Eve',   'E', NULL,           'admin',  false, 'role'),
  ('00000000-0000-0000-0000-00000000000f', 'Frank', 'F', NULL,           '',       false, 'role');
INSERT INTO user_shops (id, user_id, shop_name, shop_slug, parent_shop_id, created_at) VALUES
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Alpha Data Hub', 'alpha', NULL, '2026-01-02'),
  ('10000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000c', 'Carol Bundles',  'carol', '10000000-0000-0000-0000-00000000000a', '2026-03-02');
INSERT INTO wallets VALUES
  ('00000000-0000-0000-0000-00000000000a', 10.00),
  ('00000000-0000-0000-0000-00000000000b', 50.00),
  ('00000000-0000-0000-0000-00000000000d', 0.50),
  ('00000000-0000-0000-0000-00000000000e', 5.00),
  ('00000000-0000-0000-0000-00000000000f', 3.00),
  ('00000000-0000-0000-0000-00000000000f', 4.00);
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

-- The function the stats route served before 0170, for an equality check against admin_user_stats.
-- BEGIN COPY: migrations/optimize_admin_stats.sql get_user_financial_summary
CREATE OR REPLACE FUNCTION get_user_financial_summary(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
    v_wallet_balance NUMERIC;
    v_total_topups NUMERIC;
    v_total_spent NUMERIC;
    v_transaction_count BIGINT;
    v_orders_total BIGINT;
    v_orders_completed BIGINT;
    v_orders_failed BIGINT;
    v_shop_id UUID;
    v_shop_stats JSON := NULL;
    v_withdrawals_summary JSON;
    v_withdrawal_history JSON;
BEGIN
    -- Wallet stats
    SELECT balance INTO v_wallet_balance FROM wallets WHERE user_id = p_user_id;
    
    -- Transaction aggregation
    SELECT 
        COALESCE(SUM(CASE WHEN type = 'credit' AND source = 'wallet_topup' AND status = 'completed' THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN type = 'debit' AND status IN ('completed', 'success') THEN ABS(amount) ELSE 0 END), 0),
        COUNT(*)
    INTO v_total_topups, v_total_spent, v_transaction_count
    FROM transactions 
    WHERE user_id = p_user_id;

    -- Order counts (from the main orders table)
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE status IN ('completed', 'delivered' , 'success')),
        COUNT(*) FILTER (WHERE status = 'failed')
    INTO v_orders_total, v_orders_completed, v_orders_failed
    FROM orders 
    WHERE user_id = p_user_id;

    -- Shop Stats if user owns a shop
    SELECT id INTO v_shop_id FROM user_shops WHERE user_id = p_user_id;
    
    IF v_shop_id IS NOT NULL THEN
        SELECT json_build_object(
            'shopId', s.id,
            'shopName', s.shop_name,
            'shopSlug', s.shop_slug,
            'createdAt', s.created_at,
            'totalOrders', (SELECT COUNT(*) FROM shop_orders WHERE shop_id = v_shop_id),
            'paidOrders', (SELECT COUNT(*) FROM shop_orders WHERE shop_id = v_shop_id AND payment_status = 'completed'),
            'completedOrders', (SELECT COUNT(*) FROM shop_orders WHERE shop_id = v_shop_id AND (order_status = 'completed' OR order_status = 'delivered')),
            'totalSales', (SELECT COALESCE(SUM(total_price), 0) FROM shop_orders WHERE shop_id = v_shop_id AND payment_status = 'completed'),
            'availableBalance', COALESCE(b.available_balance, 0),
            'withdrawnAmount', COALESCE(b.withdrawn_profit, 0),
            'totalProfit', COALESCE(b.total_profit, 0),
            'pendingProfit', COALESCE(b.pending_profit, 0),
            'creditedProfit', COALESCE(b.credited_profit, 0),
            'profitRecords', (SELECT COUNT(*) FROM shop_profits WHERE shop_id = v_shop_id)
        ) INTO v_shop_stats
        FROM user_shops s
        LEFT JOIN shop_available_balance b ON s.id = b.shop_id
        WHERE s.id = v_shop_id;
    END IF;

    -- Recent withdrawal history (last 10 for quick view)
    SELECT json_agg(t) INTO v_withdrawal_history FROM (
        SELECT 
            id, amount, fee_amount as "feeAmount", net_amount as "netAmount", 
            status, withdrawal_method as method, created_at as "createdAt", reference_code as "referenceCode"
        FROM withdrawal_requests
        WHERE user_id = p_user_id
        ORDER BY created_at DESC
        LIMIT 10
    ) t;

    -- Withdrawals summary
    SELECT json_build_object(
        'totalWithdrawn', COALESCE(SUM(CASE WHEN status IN ('completed', 'approved') THEN net_amount ELSE 0 END), 0),
        'pendingCount', COUNT(*) FILTER (WHERE status = 'pending'),
        'completedCount', COUNT(*) FILTER (WHERE status IN ('completed', 'approved')),
        'history', COALESCE(v_withdrawal_history, '[]'::json)
    ) INTO v_withdrawals_summary
    FROM withdrawal_requests
    WHERE user_id = p_user_id;

    RETURN json_build_object(
        'userId', p_user_id,
        'wallet', json_build_object(
            'balance', COALESCE(v_wallet_balance, 0),
            'totalTopUps', v_total_topups,
            'totalSpent', v_total_spent,
            'transactionCount', v_transaction_count
        ),
        'orders', json_build_object(
            'total', v_orders_total,
            'completed', v_orders_completed,
            'failed', v_orders_failed,
            'pending', (v_orders_total - v_orders_completed - v_orders_failed)
        ),
        'shop', v_shop_stats,
        'withdrawals', v_withdrawals_summary
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
-- END COPY

-- The draft signatures (without p_tag), as an earlier apply of this migration left them: the DROPs remove them.
CREATE FUNCTION public.admin_list_users(text, text, boolean, boolean, text, timestamptz, timestamptz, text, text, int, int)
  RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION public.admin_export_users(text, text, boolean, boolean, text, timestamptz, timestamptz, timestamptz, uuid, int)
  RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;

\i migrations/0170_admin_list_users.sql
-- Idempotent: a second apply succeeds.
\i migrations/0170_admin_list_users.sql
-- list and export read public.admin_user_tags (0174) when called.
\i migrations/0174_admin_user_notes_tags.sql

DO $$ BEGIN
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'admin_list_users') = 1, 'one admin_list_users overload';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'admin_export_users') = 1, 'one admin_export_users overload';
END $$;

-- Tags: A carries vip and fraud-watch, C carries vip.
INSERT INTO public.admin_user_tags (user_id, tag) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'vip'), ('00000000-0000-0000-0000-00000000000a', 'fraud-watch'),
  ('00000000-0000-0000-0000-00000000000c', 'vip');

CREATE FUNCTION pg_temp.ids(v jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(right(r->>'id', 1), '' ORDER BY ord), '')
  FROM jsonb_array_elements(v->'rows') WITH ORDINALITY AS t(r, ord)
$$;

-- All ids from admin_export_users, following next_cursor; chunk = rows per call.
CREATE FUNCTION pg_temp.export_ids(chunk int, role text DEFAULT NULL, q text DEFAULT NULL, tag text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v jsonb; out text := ''; c_at timestamptz; c_id uuid; calls int := 0;
BEGIN
  LOOP
    v := public.admin_export_users(q, role, NULL, NULL, NULL, NULL, NULL, c_at, c_id, chunk, tag);
    calls := calls + 1;
    out := out || pg_temp.ids(v);
    EXIT WHEN v->'next_cursor' = 'null'::jsonb;
    ASSERT jsonb_array_length(v->'rows') = chunk, format('a non-final chunk must be full: %s', v);
    c_at := (v->'next_cursor'->>'created_at')::timestamptz;
    c_id := (v->'next_cursor'->>'id')::uuid;
    ASSERT calls < 100, 'export did not terminate';
  END LOOP;
  RETURN out;
END $$;

CREATE FUNCTION pg_temp.l(
  q text DEFAULT NULL, role text DEFAULT NULL, susp boolean DEFAULT NULL, has_shop boolean DEFAULT NULL,
  pm text DEFAULT NULL, f timestamptz DEFAULT NULL, t timestamptz DEFAULT NULL,
  sort text DEFAULT 'created_at', dir text DEFAULT 'desc', lim int DEFAULT 50, off int DEFAULT 0, tag text DEFAULT NULL
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.admin_list_users(q, role, susp, has_shop, pm, f, t, sort, dir, lim, off, tag)
$$;

DO $$
DECLARE
  v jsonb;
  r jsonb;
  msg text;
BEGIN
  -- default: created_at desc, id desc tiebreak (C and D share created_at: d > c)
  v := pg_temp.l();
  ASSERT (v->>'total')::int = 6, format('total: %s', v->'total');
  ASSERT pg_temp.ids(v) = 'edcbaf', format('default order: %s', pg_temp.ids(v));
  ASSERT pg_temp.ids(pg_temp.l(dir => 'asc')) = 'fabcde', 'created_at asc + id asc tiebreak';

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

  -- F: two wallet rows -> still one row, the larger balance; '' role -> 'user'
  SELECT x INTO r FROM jsonb_array_elements(v->'rows') x WHERE x->>'id' LIKE '%f';
  ASSERT (SELECT count(*) FROM jsonb_array_elements(v->'rows') x WHERE x->>'id' LIKE '%f') = 1, 'two wallets duplicated the user';
  ASSERT (r->>'wallet_balance')::numeric = 4 AND r->>'role' = 'user', format('F: %s', r);

  -- filters
  ASSERT pg_temp.ids(pg_temp.l(role => 'dealer')) = 'b', 'role dealer';
  ASSERT pg_temp.ids(pg_temp.l(role => 'user')) = 'daf', 'role user includes no-profile user and empty role';
  ASSERT pg_temp.ids(pg_temp.l(susp => true)) = 'b', 'suspended';
  ASSERT pg_temp.ids(pg_temp.l(susp => false)) = 'edcaf', 'not suspended';
  ASSERT pg_temp.ids(pg_temp.l(has_shop => true)) = 'ca', 'has shop';
  ASSERT pg_temp.ids(pg_temp.l(has_shop => false)) = 'edbf', 'no shop';
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
  ASSERT pg_temp.ids(pg_temp.l(sort => 'balance')) = 'baefdc', format('wallet balance desc: %s', pg_temp.ids(pg_temp.l(sort => 'balance')));
  ASSERT pg_temp.ids(pg_temp.l(sort => 'balance', dir => 'asc')) = 'cdfeab', 'wallet balance asc';
  ASSERT pg_temp.ids(pg_temp.l(sort => 'shop_balance')) = 'afedcb', 'shop balance desc, ties by id desc';
  ASSERT pg_temp.ids(pg_temp.l(sort => 'shop_balance', dir => 'asc')) = 'bcdefa', 'shop balance asc, ties by id asc';
  ASSERT pg_temp.ids(pg_temp.l(sort => 'email', dir => 'asc')) = 'abcdef', 'email asc, case-insensitive';
  ASSERT pg_temp.ids(pg_temp.l(sort => 'last_sign_in_at')) = 'acdefb', 'last sign in desc, never last';
  ASSERT pg_temp.ids(pg_temp.l(sort => 'last_sign_in_at', dir => 'asc')) = 'fedcab', 'last sign in asc, never last';
  ASSERT pg_temp.ids(pg_temp.l(sort => ' EMAIL ', dir => 'ASC')) = 'abcdef', 'sort/dir normalised';

  -- paging + clamping
  v := pg_temp.l(lim => 2, off => 0);
  ASSERT pg_temp.ids(v) = 'ed' AND (v->>'total')::int = 6, 'page 1';
  ASSERT pg_temp.ids(pg_temp.l(lim => 2, off => 2)) = 'cb', 'page 2';
  ASSERT pg_temp.ids(pg_temp.l(lim => 2, off => 4)) = 'af', 'page 3';
  v := pg_temp.l(lim => 2, off => 10);
  ASSERT pg_temp.ids(v) = '' AND (v->>'total')::int = 6, 'past the end still has total';
  ASSERT pg_temp.ids(pg_temp.l(lim => 0)) = 'e', 'limit 0 clamps to 1';
  ASSERT pg_temp.ids(pg_temp.l(lim => -5)) = 'e', 'negative limit clamps to 1';
  ASSERT pg_temp.ids(pg_temp.l(lim => 100000)) = 'edcbaf', 'huge limit clamps to 200';
  ASSERT pg_temp.ids(pg_temp.l(lim => NULL, off => -3)) = 'edcbaf', 'null limit, negative offset';

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

  -- export: keyset on (created_at, id) ascending, same filters, any chunk size gives the same rows once
  ASSERT pg_temp.export_ids(2) = 'fabcde', format('export chunk 2: %s', pg_temp.export_ids(2));
  ASSERT pg_temp.export_ids(1) = 'fabcde', 'export chunk 1';
  ASSERT pg_temp.export_ids(5000) = 'fabcde', 'export one chunk';
  ASSERT pg_temp.export_ids(2, role => 'user') = 'fad', 'export role filter';
  ASSERT pg_temp.export_ids(2, q => 'example.com') = 'abc', 'export search';
  ASSERT pg_temp.export_ids(2, q => 'nobody') = '', 'export no match';
  v := public.admin_export_users(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 2);
  ASSERT v->'next_cursor' = jsonb_build_object('created_at', '2026-01-01T10:00:00+00:00'::timestamptz, 'id', '00000000-0000-0000-0000-00000000000a'), format('cursor: %s', v->'next_cursor');
  SELECT x INTO r FROM jsonb_array_elements(v->'rows') x WHERE x->>'id' LIKE '%a';
  ASSERT (r->>'customer_count')::int = 2 AND (r->>'shop_balance')::numeric = 7.5 AND r->>'shop_name' = 'Alpha Data Hub', format('export row: %s', r);
  ASSERT jsonb_array_length(public.admin_export_users(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 999999)->'rows') = 6, 'export limit clamps to 5000';
  ASSERT jsonb_array_length(public.admin_export_users(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0)->'rows') = 1, 'export limit clamps to 1';
  BEGIN
    PERFORM public.admin_export_users(NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), NULL, 10);
    RAISE EXCEPTION 'half a cursor accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'BAD_INPUT', msg;
  END;
  -- a signup with NULL created_at is exported (first), not skipped
  INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000009', 'nodate@x.com', NULL, NULL);
  ASSERT pg_temp.export_ids(2) = '9fabcde', format('null created_at: %s', pg_temp.export_ids(2));
  DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000009';

  -- grants
  ASSERT NOT has_function_privilege('anon', 'public.admin_list_users(text,text,boolean,boolean,text,timestamptz,timestamptz,text,text,int,int,text)', 'EXECUTE'), 'anon list';
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_list_users(text,text,boolean,boolean,text,timestamptz,timestamptz,text,text,int,int,text)', 'EXECUTE'), 'authenticated list';
  ASSERT has_function_privilege('service_role', 'public.admin_list_users(text,text,boolean,boolean,text,timestamptz,timestamptz,text,text,int,int,text)', 'EXECUTE'), 'service_role list';
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_user_stats(uuid)', 'EXECUTE'), 'authenticated stats';
  ASSERT NOT has_function_privilege('anon', 'public.admin_user_stats(uuid)', 'EXECUTE'), 'anon stats';
  ASSERT has_function_privilege('service_role', 'public.admin_user_stats(uuid)', 'EXECUTE'), 'service_role stats';
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_export_users(text,text,boolean,boolean,text,timestamptz,timestamptz,timestamptz,uuid,int,text)', 'EXECUTE'), 'authenticated export';
  ASSERT NOT has_function_privilege('anon', 'public.admin_export_users(text,text,boolean,boolean,text,timestamptz,timestamptz,timestamptz,uuid,int,text)', 'EXECUTE'), 'anon export';
  ASSERT has_function_privilege('service_role', 'public.admin_export_users(text,text,boolean,boolean,text,timestamptz,timestamptz,timestamptz,uuid,int,text)', 'EXECUTE'), 'service_role export';
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_users_filtered(text,text,boolean,text,boolean,boolean,text,timestamptz,timestamptz,timestamptz,uuid)', 'EXECUTE'), 'authenticated helper';
  ASSERT NOT has_function_privilege('anon', 'public.admin_users_search_terms(text)', 'EXECUTE'), 'anon helper';

  -- tags: per-row array (A-Z, [] when none), filter in list and export, combined with other filters
  v := pg_temp.l();
  SELECT x INTO r FROM jsonb_array_elements(v->'rows') x WHERE x->>'id' LIKE '%a';
  ASSERT r->'tags' = '["fraud-watch", "vip"]'::jsonb, format('A tags: %s', r->'tags');
  SELECT x INTO r FROM jsonb_array_elements(v->'rows') x WHERE x->>'id' LIKE '%b';
  ASSERT r->'tags' = '[]'::jsonb, format('B tags: %s', r->'tags');
  v := pg_temp.l(tag => 'vip');
  ASSERT (v->>'total')::int = 2 AND pg_temp.ids(v) = 'ca', format('tag vip: %s', v);
  ASSERT pg_temp.ids(pg_temp.l(tag => '  VIP ')) = 'ca', 'tag is trimmed and lower-cased';
  ASSERT (pg_temp.l(tag => 'fraud-watch')->>'total')::int = 1, 'tag fraud-watch';
  ASSERT (pg_temp.l(tag => 'nobody-has-it')->>'total')::int = 0, 'unused tag';
  ASSERT (pg_temp.l(tag => 'vip', role => 'sub_agent')->>'total')::int = 1, 'tag + role';
  ASSERT (pg_temp.l(tag => '')->>'total')::int = 6, 'empty tag = no filter';
  ASSERT (pg_temp.l(tag => 'vip', lim => 1, off => 1)->>'total')::int = 2 AND pg_temp.ids(pg_temp.l(tag => 'vip', lim => 1, off => 1)) = 'a', 'tag paging';
  ASSERT pg_temp.export_ids(1, tag => 'vip') = 'ac', format('export tag: %s', pg_temp.export_ids(1, tag => 'vip'));
  ASSERT pg_temp.export_ids(5000, tag => 'fraud-watch') = 'a', 'export tag one chunk';
  v := public.admin_export_users(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10, 'vip');
  ASSERT v->'rows'->0->'tags' = '["fraud-watch", "vip"]'::jsonb, format('export row tags: %s', v->'rows'->0);
  -- the 11-/10-argument calls (no p_tag) still resolve, via the default
  ASSERT (public.admin_list_users(NULL,NULL,NULL,NULL,NULL,NULL,NULL,'created_at','desc',5,0)->>'total')::int = 6, 'list without p_tag';
  ASSERT jsonb_array_length(public.admin_export_users(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,10)->'rows') = 6, 'export without p_tag';
  BEGIN
    PERFORM pg_temp.l(tag => 'Bad Tag!');
    RAISE EXCEPTION 'bad tag accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'BAD_INPUT', msg;
  END;
  BEGIN
    PERFORM public.admin_export_users(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10, repeat('a', 33));
    RAISE EXCEPTION 'long tag accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'BAD_INPUT', msg;
  END;

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

  -- same JSON as the function the stats route used before, for every user (incl. F's two wallets)
  ASSERT (SELECT bool_and(public.admin_user_stats(id) = get_user_financial_summary(id)::jsonb) FROM auth.users),
    'admin_user_stats differs from get_user_financial_summary';

  RAISE NOTICE 'ADMIN_LIST_USERS_LOCAL_TEST_OK';
END $$;
