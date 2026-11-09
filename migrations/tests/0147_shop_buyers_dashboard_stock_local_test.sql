-- LOCAL ONLY. Throwaway database; builds its own stub schema.
--
--   psql -v ON_ERROR_STOP=1 -d sb_test -f migrations/tests/0147_shop_buyers_dashboard_stock_local_test.sql
--
-- Passes when it prints SHOP_BUYERS_0147_LOCAL_TEST_OK.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS user_shops (
  id uuid PRIMARY KEY, user_id uuid, shop_name text, subdomain text, is_active boolean DEFAULT false
);
CREATE TABLE IF NOT EXISTS shop_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, customer_phone text,
  payment_status text, is_stock_purchase boolean DEFAULT false, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, payment_type text, payer_phone text
);
CREATE TABLE IF NOT EXISTS ussd_shop_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, dialing_phone text, recipient_phone text,
  payment_status text, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, phone_number text);
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, phone_number text,
  status text, created_at timestamptz DEFAULT now()
);

-- Prod has 0145 applied; 0147 replaces its function.
\i migrations/0145_shop_buyers_audience.sql
\i migrations/0147_shop_buyers_dashboard_stock.sql
-- Idempotent: a second apply must not fail.
\i migrations/0147_shop_buyers_dashboard_stock.sql

DO $$
DECLARE
  dealer uuid := '00000000-0000-0000-0000-0000000000d1';  -- owns shop A
  nobody uuid := '00000000-0000-0000-0000-0000000000d2';  -- has no shop
  a uuid := '00000000-0000-0000-0000-00000000000a';       -- dealer's shop
  s uuid := '00000000-0000-0000-0000-00000000000e';       -- a sub-agent shop
  n bigint;
  v_shop uuid;
BEGIN
  INSERT INTO user_shops (id, user_id, shop_name, subdomain, is_active)
  VALUES (a, dealer, 'A', 'shopa', true), (s, NULL, 'S', 'shops', true);
  INSERT INTO users (id, phone_number) VALUES (dealer, '+233 27 777 7777');

  -- 1. Dashboard purchases by the shop owner (single + bulk both land in orders): count for shop A.
  INSERT INTO orders (user_id, phone_number, status) VALUES (dealer, '0241111111', 'completed');
  INSERT INTO orders (user_id, phone_number, status) VALUES (dealer, '233 54 222 2222', 'processing');

  -- 2. Excluded dashboard rows: refunded, and a buyer who owns no shop.
  INSERT INTO orders (user_id, phone_number, status) VALUES (dealer, '0243333333', 'refunded');
  INSERT INTO orders (user_id, phone_number, status) VALUES (nobody, '0244444444', 'completed');

  -- 3. Sub-agent stock purchase: counts for the sub-agent's own shop.
  INSERT INTO shop_orders (shop_id, customer_phone, payment_status, is_stock_purchase)
  VALUES (s, '0245555555', 'completed', true);

  -- 4. Latest-shop rule spans sources: dashboard order on A 50 days ago, stock purchase on S 5 days ago.
  INSERT INTO orders (user_id, phone_number, status, created_at)
  VALUES (dealer, '0246666666', 'completed', now() - interval '50 days');
  INSERT INTO shop_orders (shop_id, customer_phone, payment_status, is_stock_purchase, created_at)
  VALUES (s, '0246666666', 'completed', true, now() - interval '5 days');

  -- 5. The owner's own number is never a buyer of their own shop (dashboard self top-up),
  --    but still counts for another shop they bought from (falls back to S here).
  INSERT INTO orders (user_id, phone_number, status) VALUES (dealer, '0277777777', 'completed');
  INSERT INTO shop_orders (shop_id, customer_phone, payment_status, created_at)
  VALUES (s, '0277777777', 'completed', now() - interval '60 days');

  -- Expected: 241111111->A, 542222222->A, 245555555->S, 246666666->S, 277777777->S
  SELECT count(*) INTO n FROM shop_buyer_audience();
  IF n <> 5 THEN RAISE EXCEPTION 'FAIL total: expected 5, got %', n; END IF;

  SELECT shop_id INTO v_shop FROM shop_buyer_audience() WHERE phone_key = '277777777';
  IF v_shop IS DISTINCT FROM s THEN
    RAISE EXCEPTION 'FAIL owner''s own number: expected under S (not own shop A), got %', v_shop;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM shop_buyer_audience() WHERE phone_key = '241111111' AND shop_id = a)
     OR NOT EXISTS (SELECT 1 FROM shop_buyer_audience() WHERE phone_key = '542222222' AND shop_id = a) THEN
    RAISE EXCEPTION 'FAIL dashboard purchases missing from the owner''s shop';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM shop_buyer_audience() WHERE phone_key = '245555555' AND shop_id = s) THEN
    RAISE EXCEPTION 'FAIL stock purchase missing from the sub-agent shop';
  END IF;
  IF EXISTS (SELECT 1 FROM shop_buyer_audience() WHERE phone_key IN ('243333333', '244444444')) THEN
    RAISE EXCEPTION 'FAIL refunded or shop-less dashboard order is in the audience';
  END IF;

  SELECT shop_id INTO v_shop FROM shop_buyer_audience() WHERE phone_key = '246666666';
  IF v_shop <> s THEN RAISE EXCEPTION 'FAIL latest shop across sources: expected S, got %', v_shop; END IF;

  -- Window applies to dashboard orders: within 30 days A keeps only its two recent buyers.
  SELECT count(*) INTO n FROM shop_buyer_audience(now() - interval '30 days', ARRAY[a]);
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL window on A: expected 2, got %', n; END IF;

  IF (SELECT buyers FROM shop_buyer_counts() WHERE shop_id = a) <> 2
     OR (SELECT buyers FROM shop_buyer_counts() WHERE shop_id = s) <> 3 THEN
    RAISE EXCEPTION 'FAIL counts';
  END IF;

  -- Privileges survive CREATE OR REPLACE.
  IF has_function_privilege('authenticated', 'public.shop_buyer_audience(timestamptz,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.shop_buyer_audience(timestamptz,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.shop_buyer_audience(timestamptz,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL privileges';
  END IF;

  RAISE NOTICE 'SHOP_BUYERS_0147_LOCAL_TEST_OK';
END $$;
