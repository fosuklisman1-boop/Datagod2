-- 0158_bot_special_bundles.sql
--
-- Special Bundles on Hubtel USSD: the buyer has no account and pays with ONE Hubtel checkout AFTER the rows exist.
-- So this RPC creates N UNPAID channel='bots' child rows and takes no money. Dashboard Special Bundles
-- (create_special_bundle_orders, 0141) is not edited and behaves as before.
-- ADDITIVE; service-role only. NOT applied by the implementing agent. Nothing calls the RPC until a later task.
-- One transaction. Idempotent (re-runnable).
--
--   hubtel_data_orders  CHECK hubtel_data_orders_special_check widened: a special row is channel 'dashboard' or
--                       'bots', still network 'MTN', and a 'bots' row must have bot_surface set.
--   create_bot_special_bundle_orders(p_surface, p_buyer, p_shop, p_group_key, p_n, p_rows, p_total)  atomic insert,
--   replay-aware. Signature (text, text, uuid, text, integer, jsonb, numeric).
--
-- RPC contract
--   p_surface    exactly 'hubtel_ussd'; anything else => BAD_INPUT.
--   p_buyer      the dialing number in 233 form: ^233[0-9]{9}$. Stored as buyer_phone.
--   p_shop       the shop for a shop-code sale, NULL on the main code. A shop_share_amount above 0 needs a shop;
--                a main-code snapshot carries 0 or null (lib/bot-commission/orders.ts snapshot()).
--   p_group_key  same rule as isValidIdempotencyKey: ^[A-Za-z0-9-]{8,64}$. Child i gets
--                idempotency_key = p_group_key || ':' || i. A normal bot key can never contain ':'.
--   p_n          the plan multiple, 1..50; jsonb_array_length(p_rows) must equal it.
--   p_rows       jsonb array of N IDENTICAL unit objects, same keys and rules as 0141:
--                  required  network ('MTN'), service_key ('data_mtn'), beneficiary_phone (^233[0-9]{9}$),
--                            bundle_value, bundle_display, bundle_category (non-empty strings),
--                            amount (face, Hubtel price), paid_amount (the buyer's price per unit)
--                            -- both numbers > 0, at most 2 decimals, < 1,000,000, and exactly
--                            paid_amount = amount - COALESCE(cashback_amount, 0) + COALESCE(payment_fee_amount, 0)
--                  optional  cashback_amount, shop_share_amount (0..amount, at most 2 decimals),
--                            payment_fee_amount (the per-unit rail fee from quoteBots: >= 0, < 1,000,000, at most
--                            2 decimals; absent or null is stored as 0), cashback_rate, cashback_share (0..100),
--                            expected_commission (0..999999), cashback_provider (string) -- or null
--                Any other key, a non-object element, or rows that differ => BAD_INPUT.
--                The RPC sets channel, user_id (NULL), status, payment_status, bot_surface, buyer_phone, shop_id,
--                idempotency_key, reference_code ('SB-' + 12 hex), special_group_id and special_index.
--                buyer_name and buyer_email stay NULL, as on every bot order.
--   p_total      must equal N x paid_amount exactly (the amount of the one checkout that follows).
--   returns      {"group_id": uuid, "order_ids": [uuid ordered by special_index], "replay": bool}
--   errors       RAISE EXCEPTION 'BAD_INPUT' (reason in DETAIL, no PII), including a key already used under another
--                shop: a replay never crosses shops. RAISE EXCEPTION 'GROUP_CONFLICT' (SQLSTATE 23505, fixed text):
--                a unique clash that is not a same-key replay. Postgres's own message is not re-raised, because its
--                DETAIL can carry the buyer's phone. Nothing is written on any error.
--
-- Order: guard surface, buyer and key -> replay lookup of key:1 (same shop only) -> validate -> N inserts in one
-- sub-block.
--
-- No money moves here, on purpose: no wallets, no transactions, no deduct_wallet. Children end pending + unpaid, the
-- same state botCreateBundleOrder leaves a bot order in, and Hubtel's payment confirmation flips them later.
--
-- Concurrency: there is no wallet row to lock, so two identical calls at once can both miss the replay lookup. The
-- second then blocks on uq_hubtel_data_orders_bots_idem (bot_surface, buyer_phone, idempotency_key) at key:1 until
-- the first commits, gets unique_violation, and the handler returns the first call's group as a replay (or BAD_INPUT
-- if that group belongs to another shop). Any other clash rolls back every child of this call and raises
-- GROUP_CONFLICT, so a partial group can never be written.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'hubtel_data_orders_special_check';
--     -- CHECK ((((special_group_id IS NULL) AND (special_index IS NULL)) OR ((special_group_id IS NOT NULL) AND (special_index IS NOT NULL) AND ((special_index >= 1) AND (special_index <= 50)) AND (channel = 'dashboard'::text) AND (network = 'MTN'::text))))
--   SELECT count(*) FROM pg_proc WHERE proname = 'create_bot_special_bundle_orders';                    -- 0
--   SELECT count(*) FROM pg_proc WHERE proname = 'create_special_bundle_orders';                        -- 1
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'hubtel_data_orders_channel_check';
--     -- includes 'bots'
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'hubtel_data_orders_bot_surface_check';
--     -- includes 'hubtel_ussd'
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_hubtel_data_orders_bots_idem';
--     -- UNIQUE on (bot_surface, buyer_phone, idempotency_key) WHERE channel = 'bots'
--   SELECT count(*) FROM hubtel_data_orders WHERE special_group_id IS NOT NULL AND (channel <> 'dashboard' OR network <> 'MTN'); -- 0
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.hubtel_data_orders'::regclass AND NOT tgisinternal;
--     -- only trg_00_refund_status_guard, BEFORE UPDATE (anything else: read it before applying)
--
-- Self-test (self-rolling-back dry run): migrations/0158_bot_special_bundles.selftest.sql
-- That run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement
-- (the 0130 incident lesson); lib/standard-bundles/bot-special-migration.test.ts builds and checks it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. A special row may now be a bots row. Dashboard rows pass exactly as before.
ALTER TABLE public.hubtel_data_orders DROP CONSTRAINT IF EXISTS hubtel_data_orders_special_check;
ALTER TABLE public.hubtel_data_orders ADD CONSTRAINT hubtel_data_orders_special_check
  CHECK (
    (special_group_id IS NULL AND special_index IS NULL)
    -- IS NOT NULL on both: a NULL index would make BETWEEN NULL, and a CHECK that is NULL passes.
    OR (special_group_id IS NOT NULL AND special_index IS NOT NULL AND special_index BETWEEN 1 AND 50
        AND channel IN ('dashboard','bots') AND network = 'MTN'
        AND (channel <> 'bots' OR bot_surface IS NOT NULL))
  );

-- 2. N unpaid children, no money.
CREATE OR REPLACE FUNCTION public.create_bot_special_bundle_orders(
  p_surface   text,
  p_buyer     text,
  p_shop      uuid,
  p_group_key text,
  p_n         integer,
  p_rows      jsonb,
  p_total     numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_n        int;
  v_i        int;
  v_row      jsonb;
  v_unit     jsonb;
  v_key      text;
  v_amount   numeric;
  v_paid     numeric;
  v_sum      numeric;
  v_num      numeric;
  v_fee      numeric;
  v_group    uuid;
  v_shop     uuid;
  v_id       uuid;
  v_ids      jsonb := '[]'::jsonb;
BEGIN
  -- 0. Guards needed before the replay lookup.
  IF p_surface IS DISTINCT FROM 'hubtel_ussd' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'surface must be hubtel_ussd';
  END IF;
  IF p_buyer IS NULL OR p_buyer !~ '^233[0-9]{9}$' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'invalid buyer phone';
  END IF;
  IF p_group_key IS NULL OR p_group_key !~ '^[A-Za-z0-9-]{8,64}$' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'invalid group key';
  END IF;

  -- 1. Replay: the group already exists for this surface and buyer => hand it back, never insert again.
  SELECT o.special_group_id, o.shop_id INTO v_group, v_shop
    FROM public.hubtel_data_orders o
   WHERE o.channel = 'bots' AND o.bot_surface = p_surface AND o.buyer_phone = p_buyer
     AND o.idempotency_key = p_group_key || ':1';
  IF FOUND THEN
    IF v_group IS NULL THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'idempotency key already used by another order';
    END IF;
    IF v_shop IS DISTINCT FROM p_shop THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'idempotency key already used under another shop';
    END IF;
    RETURN jsonb_build_object(
      'group_id', v_group,
      'order_ids', (SELECT COALESCE(jsonb_agg(o.id ORDER BY o.special_index), '[]'::jsonb)
                      FROM public.hubtel_data_orders o
                     WHERE o.special_group_id = v_group AND o.channel = 'bots'),
      'replay', true);
  END IF;

  -- 2. Validate everything.
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'rows must be an array';
  END IF;
  IF p_n IS NULL OR p_n < 1 OR p_n > 50 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'n must be 1..50';
  END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n <> p_n THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'row count must equal n';
  END IF;

  v_unit := p_rows -> 0;
  FOR v_i IN 0 .. v_n - 1 LOOP
    v_row := p_rows -> v_i;
    IF jsonb_typeof(v_row) <> 'object' THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'every row must be an object';
    END IF;
    IF v_row <> v_unit THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'rows must be identical units';
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_unit) k
              WHERE k NOT IN ('network','service_key','beneficiary_phone','bundle_value','bundle_display',
                              'bundle_category','amount','paid_amount','cashback_amount','shop_share_amount',
                              'payment_fee_amount','cashback_rate','cashback_share','cashback_provider',
                              'expected_commission')) THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown row field';
  END IF;

  FOREACH v_key IN ARRAY ARRAY['network','service_key','beneficiary_phone','bundle_value','bundle_display','bundle_category'] LOOP
    IF jsonb_typeof(v_unit -> v_key) IS DISTINCT FROM 'string' OR btrim(v_unit ->> v_key) = '' THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'missing ' || v_key;
    END IF;
  END LOOP;
  IF v_unit ->> 'network' <> 'MTN' OR v_unit ->> 'service_key' <> 'data_mtn' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'Special bundles are MTN only';
  END IF;
  IF v_unit ->> 'beneficiary_phone' !~ '^233[0-9]{9}$' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'invalid recipient phone';
  END IF;

  IF jsonb_typeof(v_unit -> 'amount') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_unit -> 'paid_amount') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'amount and paid_amount must be numbers';
  END IF;
  v_amount := (v_unit ->> 'amount')::numeric;
  v_paid   := (v_unit ->> 'paid_amount')::numeric;
  IF NOT (v_amount > 0) OR v_amount <> round(v_amount, 2) OR v_amount >= 1000000 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'amount must be positive with at most 2 decimals';
  END IF;
  -- Not capped at amount as in 0141: a rail fee can lift paid_amount above face. The price invariant below pins it.
  IF NOT (v_paid > 0) OR v_paid <> round(v_paid, 2) OR v_paid >= 1000000 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'paid_amount must be positive with at most 2 decimals';
  END IF;

  FOREACH v_key IN ARRAY ARRAY['cashback_amount','shop_share_amount','payment_fee_amount','cashback_rate','cashback_share','expected_commission'] LOOP
    IF v_unit ? v_key AND jsonb_typeof(v_unit -> v_key) <> 'null' THEN
      IF jsonb_typeof(v_unit -> v_key) <> 'number' THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = v_key || ' must be a number';
      END IF;
      v_num := (v_unit ->> v_key)::numeric;
      IF v_num < 0
         OR (v_key IN ('cashback_amount','shop_share_amount') AND (v_num > v_amount OR v_num <> round(v_num, 2)))
         OR (v_key = 'payment_fee_amount' AND (v_num >= 1000000 OR v_num <> round(v_num, 2)))
         OR (v_key IN ('cashback_rate','cashback_share') AND v_num > 100)
         OR (v_key = 'expected_commission' AND v_num >= 1000000) THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = v_key || ' out of range';
      END IF;
    END IF;
  END LOOP;
  IF v_unit ? 'cashback_provider' AND jsonb_typeof(v_unit -> 'cashback_provider') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'cashback_provider must be a string';
  END IF;

  -- A share is credited to a shop, so a share with no shop would have nowhere to go. Zero is the main-code snapshot.
  IF p_shop IS NULL AND COALESCE((v_unit ->> 'shop_share_amount')::numeric, 0) > 0 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'shop_share_amount needs a shop';
  END IF;

  -- Price invariant (quoteBots: payAmount = face - customerCashback + paymentFee), exact numeric: a caller bug can
  -- never under- or over-charge. Cashback or fee absent or null counts as 0.
  v_fee := COALESCE((v_unit ->> 'payment_fee_amount')::numeric, 0);
  IF v_paid <> v_amount - COALESCE((v_unit ->> 'cashback_amount')::numeric, 0) + v_fee THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'paid_amount must equal amount - cashback_amount + payment_fee_amount';
  END IF;

  v_sum := v_paid * v_n;
  IF p_total IS NULL OR v_sum <> p_total THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'total does not match the rows';
  END IF;

  -- 3. N children, all or none: any error in this block rolls back every child.
  <<children>>
  BEGIN
    v_group := gen_random_uuid();

    FOR v_i IN 1 .. v_n LOOP
      INSERT INTO public.hubtel_data_orders (
        reference_code, user_id, channel, bot_surface, shop_id, buyer_phone, network, service_key, beneficiary_phone,
        bundle_value, bundle_display, bundle_category, amount, status, payment_status, idempotency_key,
        paid_amount, payment_fee_amount, cashback_amount, shop_share_amount, cashback_rate, cashback_share,
        cashback_provider, expected_commission, special_group_id, special_index, created_at, updated_at)
      VALUES (
        'SB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
        NULL, 'bots', p_surface, p_shop, p_buyer, 'MTN', 'data_mtn', v_unit ->> 'beneficiary_phone',
        v_unit ->> 'bundle_value', v_unit ->> 'bundle_display', v_unit ->> 'bundle_category',
        v_amount, 'pending', 'unpaid', p_group_key || ':' || v_i,
        v_paid, v_fee,
        (v_unit ->> 'cashback_amount')::numeric, (v_unit ->> 'shop_share_amount')::numeric,
        (v_unit ->> 'cashback_rate')::numeric, (v_unit ->> 'cashback_share')::numeric,
        v_unit ->> 'cashback_provider', (v_unit ->> 'expected_commission')::numeric,
        v_group, v_i, now(), now())
      RETURNING id INTO v_id;
      v_ids := v_ids || jsonb_build_array(v_id);
    END LOOP;

    RETURN jsonb_build_object('group_id', v_group, 'order_ids', v_ids, 'replay', false);
  EXCEPTION
    WHEN unique_violation THEN
      -- Every child of this call is rolled back. A same-key race lands here: report the winner's group, unless it
      -- belongs to another shop. Otherwise a fixed error, never Postgres's own: its DETAIL can carry the phone.
      SELECT o.special_group_id, o.shop_id INTO v_group, v_shop
        FROM public.hubtel_data_orders o
       WHERE o.channel = 'bots' AND o.bot_surface = p_surface AND o.buyer_phone = p_buyer
         AND o.idempotency_key = p_group_key || ':1' AND o.special_group_id IS NOT NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'GROUP_CONFLICT' USING ERRCODE = 'unique_violation', DETAIL = 'unique clash while creating the group';
      END IF;
      IF v_shop IS DISTINCT FROM p_shop THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'idempotency key already used under another shop';
      END IF;
      RETURN jsonb_build_object(
        'group_id', v_group,
        'order_ids', (SELECT COALESCE(jsonb_agg(o.id ORDER BY o.special_index), '[]'::jsonb)
                        FROM public.hubtel_data_orders o
                       WHERE o.special_group_id = v_group AND o.channel = 'bots'),
        'replay', true);
  END children;
END
$fn$;

REVOKE ALL ON FUNCTION public.create_bot_special_bundle_orders(text, text, uuid, text, integer, jsonb, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_bot_special_bundle_orders(text, text, uuid, text, integer, jsonb, numeric) TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'hubtel_data_orders_special_check';
--     -- includes 'dashboard', 'bots', network 'MTN' and bot_surface IS NOT NULL
--   SELECT p.prosecdef, p.proconfig FROM pg_proc p WHERE p.proname = 'create_bot_special_bundle_orders';
--     -- true, {search_path=public}
--   SELECT has_function_privilege('anon', 'public.create_bot_special_bundle_orders(text,text,uuid,text,integer,jsonb,numeric)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.create_bot_special_bundle_orders(text,text,uuid,text,integer,jsonb,numeric)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.create_bot_special_bundle_orders(text,text,uuid,text,integer,jsonb,numeric)', 'EXECUTE');
--     -- false, false, true
--   SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'create_bot_special_bundle_orders';
--     -- exactly one row: p_surface text, p_buyer text, p_shop uuid, p_group_key text, p_n integer, p_rows jsonb, p_total numeric
--   SELECT count(*) FROM hubtel_data_orders WHERE special_group_id IS NOT NULL AND channel = 'bots';   -- 0 until the switch is on
