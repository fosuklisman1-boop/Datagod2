-- LOCAL ONLY. Throwaway database; builds its own stub schema.
--
--   psql -v ON_ERROR_STOP=1 -d sb_test -f migrations/tests/0145_shop_buyers_audience_local_test.sql
--
-- Passes when it prints SHOP_BUYERS_LOCAL_TEST_OK.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS user_shops (id uuid PRIMARY KEY, shop_name text, subdomain text, is_active boolean DEFAULT false);
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

\i migrations/0145_shop_buyers_audience.sql
-- Idempotent: a second apply must not fail.
\i migrations/0145_shop_buyers_audience.sql

DO $$
DECLARE
  a uuid := '00000000-0000-0000-0000-00000000000a';  -- active shop A
  b uuid := '00000000-0000-0000-0000-00000000000b';  -- active shop B
  c uuid := '00000000-0000-0000-0000-00000000000c';  -- INACTIVE shop C
  o uuid;
  n bigint;
  v_shop uuid;
BEGIN
  INSERT INTO user_shops VALUES (a, 'A', 'shopa', true), (b, 'B', 'shopb', true), (c, 'C', 'shopc', false);

  -- 1. Storefront order on A: customer 0241111111, MoMo payer +233 20 222 2222.
  INSERT INTO shop_orders (shop_id, customer_phone, payment_status, created_at)
  VALUES (a, '0241111111', 'completed', now() - interval '100 days') RETURNING id INTO o;
  INSERT INTO payment_attempts (order_id, payment_type, payer_phone) VALUES (o, 'shop_order', '+233 20 222 2222');

  -- 2. Same customer later on B via USSD, in 233 form: latest shop becomes B.
  INSERT INTO ussd_shop_orders (shop_id, dialing_phone, recipient_phone, payment_status, created_at)
  VALUES (b, '233241111111', '0553333333', 'completed', now() - interval '10 days');

  -- 3. Excluded: unpaid, stock purchase, invalid number, inactive shop.
  INSERT INTO shop_orders (shop_id, customer_phone, payment_status) VALUES (a, '0244444444', 'pending');
  INSERT INTO shop_orders (shop_id, customer_phone, payment_status, is_stock_purchase) VALUES (a, '0245555555', 'completed', true);
  INSERT INTO shop_orders (shop_id, customer_phone, payment_status) VALUES (a, '12345', 'completed');
  INSERT INTO shop_orders (shop_id, customer_phone, payment_status) VALUES (c, '0246666666', 'completed');

  -- 4. Opted out.
  INSERT INTO shop_orders (shop_id, customer_phone, payment_status) VALUES (a, '0247777777', 'completed');
  INSERT INTO sms_marketing_opt_outs (phone_key) VALUES ('247777777');

  -- Expected audience: 241111111->B, 202222222->A, 553333333->B
  SELECT count(*) INTO n FROM shop_buyer_audience();
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL total: expected 3, got %', n; END IF;

  SELECT shop_id INTO v_shop FROM shop_buyer_audience() WHERE phone_key = '241111111';
  IF v_shop <> b THEN RAISE EXCEPTION 'FAIL latest shop: 241111111 should be B, got %', v_shop; END IF;

  IF NOT EXISTS (SELECT 1 FROM shop_buyer_audience() WHERE phone_key = '202222222' AND shop_id = a) THEN
    RAISE EXCEPTION 'FAIL payer phone (payment_attempts) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM shop_buyer_audience() WHERE phone_key = '553333333' AND shop_id = b) THEN
    RAISE EXCEPTION 'FAIL ussd recipient missing';
  END IF;
  IF EXISTS (SELECT 1 FROM shop_buyer_audience() WHERE phone_key IN ('244444444', '245555555', '246666666', '247777777')) THEN
    RAISE EXCEPTION 'FAIL an excluded number is in the audience';
  END IF;

  -- Shop filter applies AFTER the latest pick: filtering to A must NOT bring back 241111111.
  SELECT count(*) INTO n FROM shop_buyer_audience(NULL, ARRAY[a]);
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL shop filter A: expected 1, got %', n; END IF;

  -- Window: last 30 days drops the 100-day-old storefront order (and its payer).
  SELECT count(*) INTO n FROM shop_buyer_audience(now() - interval '30 days');
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL window: expected 2, got %', n; END IF;

  -- Counts equal the audience.
  IF (SELECT buyers FROM shop_buyer_counts() WHERE shop_id = b) <> 2
     OR (SELECT buyers FROM shop_buyer_counts() WHERE shop_id = a) <> 1
     OR (SELECT count(*) FROM shop_buyer_counts()) <> 2 THEN
    RAISE EXCEPTION 'FAIL counts';
  END IF;

  -- Privileges: only service_role may execute.
  IF has_function_privilege('authenticated', 'public.shop_buyer_audience(timestamptz,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.shop_buyer_counts(timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.shop_buyer_audience(timestamptz,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL privileges';
  END IF;

  -- Opt-out key format is enforced.
  BEGIN
    INSERT INTO sms_marketing_opt_outs (phone_key) VALUES ('0241');
    RAISE EXCEPTION 'FAIL opt-out check constraint accepted a bad key';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'SHOP_BUYERS_LOCAL_TEST_OK';
END $$;
