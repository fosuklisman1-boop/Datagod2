-- LOCAL ONLY. Never run against production: it creates stub tables.
--
-- Exercises 0133_leaderboard_engine.sql against a stub schema in an EMPTY
-- database, with fixtures whose expected totals are worked out by hand.
-- Stub column types mirror production where it matters (orders.created_at and
-- shop_orders.created_at are timestamp WITHOUT time zone; the rest timestamptz).
--
--   createdb lb_test
--   psql -v ON_ERROR_STOP=1 -d lb_test -f migrations/tests/0133_leaderboard_engine_local_test.sql
--
-- Passes when it prints LEADERBOARD_LOCAL_TEST_OK. Any failed ASSERT aborts.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE users (id uuid PRIMARY KEY, email text, first_name text, last_name text, role text);
CREATE TABLE user_shops (id uuid PRIMARY KEY, user_id uuid, parent_shop_id uuid);
CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, price numeric(10,2), status varchar(50), created_at timestamp);
CREATE TABLE api_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, price numeric, status text, created_at timestamptz);
CREATE TABLE airtime_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, shop_id uuid, total_paid numeric(10,2), paid_amount numeric(12,2), status text, created_at timestamptz);
CREATE TABLE afa_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, amount numeric(10,2), status varchar(50), created_at timestamptz);
CREATE TABLE results_checker_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, shop_id uuid, total_paid numeric(10,2), status text, created_at timestamptz);
CREATE TABLE hubtel_bill_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, shop_id uuid, amount numeric(12,2), paid_amount numeric(12,2), status text, created_at timestamptz);
CREATE TABLE hubtel_data_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, shop_id uuid, amount numeric(12,2), paid_amount numeric(12,2), status text, created_at timestamptz);
CREATE TABLE shop_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, customer_email varchar(255), profit_amount numeric(10,2), total_price numeric(10,2), order_status varchar(50), payment_status varchar(50), created_at timestamp);
CREATE TABLE ussd_shop_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, amount numeric(10,2), order_status varchar(50), payment_status varchar(50), created_at timestamptz);

-- People: A dashboard buyer, B shop owner, C sub-agent under B, D admin,
-- E excluded, G/H/F tie-break trio.
INSERT INTO users VALUES
  ('00000000-0000-0000-0000-00000000000a', 'a@x', 'Anthony', 'Asare', 'user'),
  ('00000000-0000-0000-0000-00000000000b', 'b@x', 'Michael', 'Iddrisu', 'dealer'),
  ('00000000-0000-0000-0000-00000000000c', 'c@x', 'Dcee', 'Boateng', 'user'),
  ('00000000-0000-0000-0000-00000000000d', 'd@x', 'Admin', 'Person', 'admin'),
  ('00000000-0000-0000-0000-00000000000e', 'e@x', 'Test', 'Account', 'user'),
  ('00000000-0000-0000-0000-000000000006', 'f@x', 'Fifi', 'F', 'user'),
  ('00000000-0000-0000-0000-000000000007', 'g@x', 'Gina', 'G', 'user'),
  ('00000000-0000-0000-0000-000000000008', 'h@x', 'Hana', 'H', 'user');
INSERT INTO user_shops VALUES
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', NULL),
  ('10000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-00000000000b');

-- A, dashboard, 2026-10-10: 10 + 2.5 + 3.5 (paid_amount wins) + 1 + 2 + 20 + 1 = 40.00 over 7 orders
INSERT INTO orders (user_id, price, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 10.00, 'completed', '2026-10-10 23:30:00'),
  ('00000000-0000-0000-0000-00000000000a', 99.00, 'failed',    '2026-10-10 10:00:00'),
  ('00000000-0000-0000-0000-00000000000a',  5.00, 'completed', '2026-10-09 23:59:59');  -- previous day
INSERT INTO api_orders (user_id, price, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 2.50, 'completed', '2026-10-10 12:00+00');
INSERT INTO airtime_orders (user_id, shop_id, total_paid, paid_amount, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', NULL, 4.00, 3.50, 'completed', '2026-10-10 12:00+00'),
  (NULL, '10000000-0000-0000-0000-00000000000b', 7.00, NULL, 'completed', '2026-10-10 12:00+00');  -- storefront -> shop B
INSERT INTO afa_orders (user_id, amount, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 1.00, 'completed', '2026-10-10 12:00+00');
INSERT INTO results_checker_orders (user_id, shop_id, total_paid, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', NULL, 2.00, 'completed', '2026-10-10 12:00+00'),
  (NULL, '10000000-0000-0000-0000-00000000000c', 6.00, 'completed', '2026-10-10 12:00+00');      -- storefront -> shop C
INSERT INTO hubtel_bill_orders (user_id, shop_id, amount, paid_amount, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', NULL, 20.00, NULL, 'completed', '2026-10-10 12:00+00'),
  (NULL, '10000000-0000-0000-0000-00000000000b', 8.00, NULL, 'completed', '2026-10-10 12:00+00'); -- storefront -> shop B
INSERT INTO hubtel_data_orders (user_id, shop_id, amount, paid_amount, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', NULL, 1.00, NULL, 'completed', '2026-10-10 12:00+00'),
  ('00000000-0000-0000-0000-00000000000a', NULL, 9.00, NULL, 'refunded',  '2026-10-10 12:00+00');

-- Shops, 2026-10-10
INSERT INTO shop_orders (shop_id, customer_email, profit_amount, total_price, order_status, payment_status, created_at) VALUES
  ('10000000-0000-0000-0000-00000000000b', 'cust@x', 2.00, 50.00, 'completed', 'completed', '2026-10-10 12:00'),
  ('10000000-0000-0000-0000-00000000000b', 'cust@x', 2.00, 70.00, 'completed', 'pending',   '2026-10-10 12:00'), -- unpaid
  ('10000000-0000-0000-0000-00000000000c', 'cust@x', 1.00, 30.00, 'completed', 'completed', '2026-10-10 12:00'), -- sub-agent sale -> C only
  ('10000000-0000-0000-0000-00000000000c', 'C@X',    0.00, 12.00, 'completed', 'completed', '2026-10-10 12:00'), -- stock buy -> dashboard C
  ('10000000-0000-0000-0000-00000000000c', 'cust2@x',0.00,  9.00, 'completed', 'completed', '2026-10-10 12:00'); -- zero-markup customer sale
INSERT INTO ussd_shop_orders (shop_id, amount, order_status, payment_status, created_at) VALUES
  ('10000000-0000-0000-0000-00000000000b', 15.00, 'completed', 'completed', '2026-10-10 12:00+00');

-- Excluded people and the tie-break trio (all 2026-10-10)
INSERT INTO orders (user_id, price, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000d', 1000.00, 'completed', '2026-10-10 12:00'),
  ('00000000-0000-0000-0000-00000000000e',  500.00, 'completed', '2026-10-10 12:00'),
  ('00000000-0000-0000-0000-000000000007',   20.00, 'completed', '2026-10-10 08:00'),
  ('00000000-0000-0000-0000-000000000007',   20.00, 'completed', '2026-10-10 08:00'),
  ('00000000-0000-0000-0000-000000000008',   20.00, 'completed', '2026-10-10 09:00'),
  ('00000000-0000-0000-0000-000000000008',   20.00, 'completed', '2026-10-10 09:00'),
  ('00000000-0000-0000-0000-000000000006',   40.00, 'completed', '2026-10-10 07:00');

\i migrations/0133_leaderboard_engine.sql
\i migrations/0134_leaderboard_indexes.sql

INSERT INTO leaderboard_exclusions (user_id, reason) VALUES ('00000000-0000-0000-0000-00000000000e', 'test account');

DO $$
DECLARE
  v jsonb; n int; n2 int;
  A uuid := '00000000-0000-0000-0000-00000000000a';
  B uuid := '00000000-0000-0000-0000-00000000000b';
  C uuid := '00000000-0000-0000-0000-00000000000c';
  H uuid := '00000000-0000-0000-0000-000000000008';
BEGIN
  -- backfill flagged exactly the stock purchase (email match is case-insensitive)
  SELECT count(*) INTO n FROM shop_orders WHERE is_stock_purchase;
  ASSERT n = 1, format('expected 1 stock purchase flagged, got %s', n);

  n := refresh_leaderboard_totals('2026-10-09', '2026-10-10');
  n2 := refresh_leaderboard_totals('2026-10-09', '2026-10-10');
  ASSERT n = n2, 'refresh is not idempotent';

  -- Dashboard 2026-10-10: A 40 (7 orders), G 40 (2, 08:00), H 40 (2, 09:00), F 40 (1), C 12
  v := get_leaderboard('dashboard', '2026-10-10', '2026-10-10', 30);
  ASSERT (v->>'participants')::int = 5, format('dashboard participants: %s', v);
  ASSERT v->'entries'->0->>'first_name' = 'Anthony' AND (v->'entries'->0->>'total')::numeric = 40.00
     AND (v->'entries'->0->>'orders')::int = 7, format('dashboard #1: %s', v->'entries'->0);
  ASSERT v->'entries'->1->>'first_name' = 'Gina', format('tie-break #2: %s', v->'entries'->1);
  ASSERT v->'entries'->2->>'first_name' = 'Hana', format('tie-break #3: %s', v->'entries'->2);
  ASSERT v->'entries'->3->>'first_name' = 'Fifi', format('tie-break #4: %s', v->'entries'->3);
  ASSERT v->'entries'->4->>'first_name' = 'Dcee' AND (v->'entries'->4->>'total')::numeric = 12.00,
    format('stock purchase on sub-agent dashboard: %s', v->'entries'->4);
  ASSERT NOT (v::text LIKE '%Admin%' OR v::text LIKE '%Test%'), 'admin or excluded user ranked';

  -- Shop 2026-10-10: B 7 + 8 + 50 + 15 = 80; C 6 + 30 + 9 = 45 (nothing rolls up to parent B)
  v := get_leaderboard('shop', '2026-10-10', '2026-10-10', 30);
  ASSERT (v->>'participants')::int = 2, format('shop participants: %s', v);
  ASSERT (v->'entries'->0->>'user_id')::uuid = B AND (v->'entries'->0->>'total')::numeric = 80.00,
    format('shop #1: %s', v->'entries'->0);
  ASSERT (v->'entries'->1->>'user_id')::uuid = C AND (v->'entries'->1->>'total')::numeric = 45.00,
    format('shop #2: %s', v->'entries'->1);

  -- Day boundary: the 23:59:59 order on 10-09 joins only when the range includes 10-09
  v := get_leaderboard('dashboard', '2026-10-09', '2026-10-10', 1);
  ASSERT (v->'entries'->0->>'total')::numeric = 45.00, format('two-day range: %s', v);
  ASSERT jsonb_array_length(v->'entries') = 1, 'limit not applied';

  -- My rank
  v := get_leaderboard_rank(H, 'dashboard', '2026-10-10', '2026-10-10');
  ASSERT (v->>'rank')::int = 3 AND (v->>'next_total')::numeric = 40 AND (v->>'third_total')::numeric = 40,
    format('rank H: %s', v);
  v := get_leaderboard_rank(B, 'dashboard', '2026-10-10', '2026-10-10');
  ASSERT v->>'rank' IS NULL AND (v->>'total')::numeric = 0, format('rank of non-participant: %s', v);
  v := get_leaderboard_rank(A, 'dashboard', '2026-10-10', '2026-10-10');
  ASSERT (v->>'rank')::int = 1 AND v->>'next_total' IS NULL, format('rank A: %s', v);

  -- A refund after refresh disappears on the next refresh
  UPDATE hubtel_bill_orders SET status = 'refunded' WHERE user_id = A;
  PERFORM refresh_leaderboard_totals('2026-10-10', '2026-10-10');
  v := get_leaderboard_rank(A, 'dashboard', '2026-10-10', '2026-10-10');
  ASSERT (v->>'total')::numeric = 20.00 AND (v->>'rank')::int = 4, format('after refund: %s', v);

  -- Guard rails
  BEGIN
    PERFORM refresh_leaderboard_totals('2026-10-10', '2026-10-01');
    RAISE EXCEPTION 'reversed range accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'reversed range accepted' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'LEADERBOARD_LOCAL_TEST_OK';
END $$;
