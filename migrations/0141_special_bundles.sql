-- 0141_special_bundles.sql
--
-- Special Bundles (MTN, dashboard wallet only): one purchase = ONE wallet debit + N ordinary Standard Bundle
-- child rows in hubtel_data_orders, linked by special_group_id and numbered by special_index 1..N. Each child
-- is then dispatched by the existing dispatchBundleOrder exactly like a single dashboard order.
-- ADDITIVE; service-role only. NOT applied by the implementing agent.
-- One transaction. Idempotent (re-runnable).
--
--   hubtel_data_orders  + special_group_id uuid NULL, special_index smallint NULL (metadata-only ADD COLUMNs);
--                       CHECK hubtel_data_orders_special_check: both set or both NULL, index 1..50, and a
--                       special row is always channel 'dashboard' + network 'MTN';
--                       UNIQUE INDEX uq_hubtel_data_orders_special_child (special_group_id, special_index)
--                       WHERE special_group_id IS NOT NULL (also the lookup index for a group).
--   create_special_bundle_orders(p_user, p_group_key, p_n, p_rows, p_total)  atomic debit + insert,
--   replay-aware. Signature (uuid, text, integer, jsonb, numeric).
--
-- RPC contract
--   p_group_key  the client's idempotencyKey, same rule as isValidIdempotencyKey: ^[A-Za-z0-9-]{8,64}$.
--                Child i gets idempotency_key = p_group_key || ':' || i. A normal dashboard key can never
--                contain ':', so the 0118 UNIQUE (user_id, idempotency_key) cannot clash with a normal order.
--   p_n          the plan multiple, 1..50; jsonb_array_length(p_rows) must equal it.
--   p_rows       jsonb array of N IDENTICAL unit objects (a Special plan is N x the same unit). Keys:
--                  required  network ('MTN'), service_key ('data_mtn'), beneficiary_phone (^233[0-9]{9}$),
--                            bundle_value, bundle_display, bundle_category (non-empty strings),
--                            amount (face, Hubtel price), paid_amount (wallet charge per unit)
--                            -- both numbers > 0, at most 2 decimals, < 1,000,000, and exactly
--                            paid_amount = amount - COALESCE(cashback_amount, 0)
--                  optional  cashback_amount, shop_share_amount (0..amount, at most 2 decimals), cashback_rate,
--                            cashback_share (0..100), expected_commission (0..999999), cashback_provider
--                            (string) -- or null
--                Any other key, a non-object element, or rows that differ => BAD_INPUT.
--                The RPC sets channel, user_id, status, payment_status, idempotency_key, reference_code
--                ('SB-' + 12 hex, same shape as runtime.newReference), special_group_id and special_index.
--   p_total      must equal N x paid_amount (= the sum of the children's paid_amount) exactly.
--   returns      {"group_id": uuid, "order_ids": [uuid ordered by special_index], "replay": bool}
--   errors       RAISE EXCEPTION 'BAD_INPUT' (reason in DETAIL, no PII) / 'INSUFFICIENT_FUNDS'
--                (balance short, or no wallet row: data_order_debit also reports a missing wallet as
--                'insufficient'). Nothing is written on either error.
--
-- Order: guard p_user / p_group_key -> lock the wallet row (FOR UPDATE) -> replay lookup of
-- p_group_key || ':1' -> validate -> deduct_wallet(p_user, p_total) -> one transactions row -> N inserts.
--
-- Money path mirrors data_order_debit (0118, as amended by 0119) exactly:
--   * deduct_wallet(user, pay) (0089: positivity guard; balance >= pay; balance and total_spent updated);
--   * ONE transactions row: type 'debit', source 'standard_bundle', amount = the total charged,
--     balance_before/after from deduct_wallet, status 'completed'. Differences, on purpose: one row for
--     the whole group (one debit), description 'Special bundle: MTN <N> x <display> to <phone>', and
--     reference_id 'SPECIAL-<group_id>' (data_order_debit uses the single order's reference_code; the
--     transactions UNIQUE (user_id, reference_id, type) is satisfied by the unique group id);
--   * children end as status 'pending' + payment_status 'paid' -- exactly the state data_order_debit
--     leaves a dashboard order in, ready for dispatchBundleOrder's claim. paid_at stays NULL, as for
--     every dashboard order.
--   Per-child refunds keep working unchanged: they credit paid_amount with reference data-refund-<id>.
--
-- Concurrency:
--   * Same key twice: both calls lock the wallet row first; the second waits, then (READ COMMITTED,
--     fresh snapshot per statement) sees the first call's committed children and returns the replay.
--     Exactly one debit.
--   * Different keys: serialised on the wallet lock; each re-reads the balance under it, so both succeed
--     when funds allow and the second gets INSUFFICIENT_FUNDS when they do not.
--   * Backstop: a unique_violation inside the money block rolls the debit back; if the group now exists
--     it is returned as a replay, otherwise the error is re-raised (nothing charged).
--   * Lock order: wallet row, then new rows only. data_order_debit locks order row -> wallet; no row is
--     shared, so no deadlock cycle.
--
-- Triggers on hubtel_data_orders in this repo (checked 2026-10-30): only trg_00_refund_status_guard,
-- BEFORE UPDATE (0120). Nothing fires on INSERT. Prod may carry triggers not in the repo: see PRE-CHECKS.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
--      AND table_name = 'hubtel_data_orders' AND column_name IN ('special_group_id','special_index'); -- 0
--   SELECT count(*) FROM pg_proc WHERE proname = 'create_special_bundle_orders';                        -- 0
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'hubtel_data_orders_channel_check';
--     -- includes 'dashboard'
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.hubtel_data_orders'::regclass AND NOT tgisinternal;
--     -- only trg_00_refund_status_guard (anything else: read it before applying)
--   SELECT count(*) FROM pg_proc WHERE proname = 'deduct_wallet' AND prosecdef;                         -- 1
--
-- Self-test (self-rolling-back dry run): migrations/0141_special_bundles.selftest.sql
-- That run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement
-- (the 0130 incident lesson); lib/standard-bundles/special-migration.test.ts builds and checks it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Group columns (nullable, no default: metadata-only).
ALTER TABLE public.hubtel_data_orders
  ADD COLUMN IF NOT EXISTS special_group_id uuid,
  ADD COLUMN IF NOT EXISTS special_index    smallint;

ALTER TABLE public.hubtel_data_orders DROP CONSTRAINT IF EXISTS hubtel_data_orders_special_check;
ALTER TABLE public.hubtel_data_orders ADD CONSTRAINT hubtel_data_orders_special_check
  CHECK (
    (special_group_id IS NULL AND special_index IS NULL)
    -- IS NOT NULL on both: a NULL index would make BETWEEN NULL, and a CHECK that is NULL passes.
    OR (special_group_id IS NOT NULL AND special_index IS NOT NULL AND special_index BETWEEN 1 AND 50
        AND channel = 'dashboard' AND network = 'MTN')
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_hubtel_data_orders_special_child
  ON public.hubtel_data_orders (special_group_id, special_index)
  WHERE special_group_id IS NOT NULL;

-- 2. Atomic one-debit, N-children purchase.
-- An earlier draft had no p_n (uuid, text, jsonb, numeric). It was never applied, but drop it if present so
-- only the p_n signature exists and no stale grant survives.
DROP FUNCTION IF EXISTS public.create_special_bundle_orders(uuid, text, jsonb, numeric);

CREATE OR REPLACE FUNCTION public.create_special_bundle_orders(
  p_user      uuid,
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
  v_group    uuid;
  v_id       uuid;
  v_ids      jsonb := '[]'::jsonb;
  d          record;
BEGIN
  -- 0. Guards needed before the lock and the replay lookup.
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'user required';
  END IF;
  IF p_group_key IS NULL OR p_group_key !~ '^[A-Za-z0-9-]{8,64}$' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'invalid group key';
  END IF;

  -- 1. Lock the wallet row FIRST: serialises every Special purchase for this user, so a concurrent call with
  --    the same key waits here and then sees the committed group below. No row = no wallet; the debit
  --    reports that as INSUFFICIENT_FUNDS after validation (as data_order_debit does).
  PERFORM 1 FROM public.wallets w WHERE w.user_id = p_user FOR UPDATE;

  -- 2. Replay: the group already exists for this user => hand it back, never debit again.
  SELECT o.special_group_id INTO v_group
    FROM public.hubtel_data_orders o
   WHERE o.user_id = p_user AND o.idempotency_key = p_group_key || ':1';
  IF FOUND THEN
    IF v_group IS NULL THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'idempotency key already used by another order';
    END IF;
    RETURN jsonb_build_object(
      'group_id', v_group,
      'order_ids', (SELECT COALESCE(jsonb_agg(o.id ORDER BY o.special_index), '[]'::jsonb)
                      FROM public.hubtel_data_orders o
                     WHERE o.special_group_id = v_group AND o.user_id = p_user),
      'replay', true);
  END IF;

  -- 3. Validate everything.
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
                              'cashback_rate','cashback_share','cashback_provider','expected_commission')) THEN
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
  IF NOT (v_paid > 0) OR v_paid <> round(v_paid, 2) OR v_paid > v_amount THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'paid_amount must be positive, at most 2 decimals, not above amount';
  END IF;

  FOREACH v_key IN ARRAY ARRAY['cashback_amount','shop_share_amount','cashback_rate','cashback_share','expected_commission'] LOOP
    IF v_unit ? v_key AND jsonb_typeof(v_unit -> v_key) <> 'null' THEN
      IF jsonb_typeof(v_unit -> v_key) <> 'number' THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = v_key || ' must be a number';
      END IF;
      v_num := (v_unit ->> v_key)::numeric;
      IF v_num < 0
         OR (v_key IN ('cashback_amount','shop_share_amount') AND (v_num > v_amount OR v_num <> round(v_num, 2)))
         OR (v_key IN ('cashback_rate','cashback_share') AND v_num > 100)
         OR (v_key = 'expected_commission' AND v_num >= 1000000) THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = v_key || ' out of range';
      END IF;
    END IF;
  END LOOP;
  IF v_unit ? 'cashback_provider' AND jsonb_typeof(v_unit -> 'cashback_provider') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'cashback_provider must be a string';
  END IF;

  -- Price invariant (quoteCashback: payAmount = face - customerCashback), exact numeric: a caller bug can
  -- never under- or over-charge. No cashback (absent or null) => paid_amount must equal amount.
  IF v_paid <> v_amount - COALESCE((v_unit ->> 'cashback_amount')::numeric, 0) THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'paid_amount must equal amount - cashback_amount';
  END IF;

  v_sum := v_paid * v_n;
  IF p_total IS NULL OR v_sum <> p_total THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'total does not match the rows';
  END IF;

  -- 4-5. Money: one debit, one history row, N children. Any error here rolls the debit back.
  <<money>>
  BEGIN
    SELECT * INTO d FROM public.deduct_wallet(p_user, p_total);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
    END IF;

    v_group := gen_random_uuid();

    INSERT INTO public.transactions (user_id, type, source, amount, balance_before, balance_after, description, reference_id, status, created_at)
    VALUES (p_user, 'debit', 'standard_bundle', p_total, d.old_balance, d.new_balance,
            'Special bundle: MTN ' || v_n || ' x ' || (v_unit ->> 'bundle_display') || ' to ' || (v_unit ->> 'beneficiary_phone'),
            'SPECIAL-' || v_group::text, 'completed', now());

    FOR v_i IN 1 .. v_n LOOP
      INSERT INTO public.hubtel_data_orders (
        reference_code, user_id, channel, network, service_key, beneficiary_phone,
        bundle_value, bundle_display, bundle_category, amount, status, payment_status, idempotency_key,
        paid_amount, cashback_amount, shop_share_amount, cashback_rate, cashback_share, cashback_provider,
        expected_commission, special_group_id, special_index, created_at, updated_at)
      VALUES (
        'SB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
        p_user, 'dashboard', 'MTN', 'data_mtn', v_unit ->> 'beneficiary_phone',
        v_unit ->> 'bundle_value', v_unit ->> 'bundle_display', v_unit ->> 'bundle_category',
        v_amount, 'pending', 'paid', p_group_key || ':' || v_i,
        v_paid,
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
      -- Debit and inserts are rolled back. Unreachable for a same-key race (the wallet lock serialises it);
      -- kept as a backstop: report the group if it exists, otherwise re-raise (nothing charged).
      SELECT o.special_group_id INTO v_group
        FROM public.hubtel_data_orders o
       WHERE o.user_id = p_user AND o.idempotency_key = p_group_key || ':1' AND o.special_group_id IS NOT NULL;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      RETURN jsonb_build_object(
        'group_id', v_group,
        'order_ids', (SELECT COALESCE(jsonb_agg(o.id ORDER BY o.special_index), '[]'::jsonb)
                        FROM public.hubtel_data_orders o
                       WHERE o.special_group_id = v_group AND o.user_id = p_user),
        'replay', true);
  END money;
END
$fn$;

REVOKE ALL ON FUNCTION public.create_special_bundle_orders(uuid, text, integer, jsonb, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_special_bundle_orders(uuid, text, integer, jsonb, numeric) TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'hubtel_data_orders'
--      AND column_name IN ('special_group_id','special_index');          -- uuid YES, smallint YES
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'hubtel_data_orders_special_check';
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_hubtel_data_orders_special_child';
--   SELECT p.prosecdef, p.proconfig FROM pg_proc p WHERE p.proname = 'create_special_bundle_orders';
--     -- true, {search_path=public}
--   SELECT has_function_privilege('anon', 'public.create_special_bundle_orders(uuid,text,integer,jsonb,numeric)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.create_special_bundle_orders(uuid,text,integer,jsonb,numeric)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.create_special_bundle_orders(uuid,text,integer,jsonb,numeric)', 'EXECUTE');
--     -- false, false, true
--   SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'create_special_bundle_orders';
--     -- exactly one row: p_user uuid, p_group_key text, p_n integer, p_rows jsonb, p_total numeric
--     -- false, false, true
--   SELECT count(*) FROM hubtel_data_orders WHERE special_group_id IS NOT NULL;   -- 0 until the switch is on
