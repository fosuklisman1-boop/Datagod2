-- 0130_api_v2_orders.sql
--
-- Lets Developer API v2 keys place data orders. v2 orders go into the
-- EXISTING api_orders table so fulfillment, status sync, refunds, order
-- health and delivery notifications keep seeing them unchanged. v1 is NOT
-- touched: place_api_order and every v1 row keep working exactly as before.
--
--   api_orders      api_key_id (v1 key, user_api_keys) becomes nullable and a
--                   new api_v2_key_id (v2 key, api_v2_keys) is added. CHECK
--                   api_orders_exactly_one_key: every row carries exactly one
--                   of the two. All 1,573 existing rows have a v1 key, so the
--                   check validates cleanly. The CHECKs are added NOT VALID
--                   and then VALIDATEd only so the idempotency guard is
--                   simple; this gives NO lock benefit here, because the
--                   earlier ALTERs in this transaction already hold ACCESS
--                   EXCLUSIVE on the table until COMMIT. The tables are small
--                   (about 1.6k rows), so the validation scan is brief.
--   sandbox_orders  same split (controller ruling 2026-10-23): v2 TEST keys
--                   live in api_v2_keys, so a v2 sandbox purchase would
--                   violate the user_api_keys FK. CHECK
--                   sandbox_orders_exactly_one_key; all existing rows have a
--                   v1 key.
--   place_api_v2_order(...)  atomic, replay-aware placement for v2 live keys.
--
-- place_api_v2_order contract (jsonb):
--   success  {success:true, replayed:false, order_id, new_balance, created_at}
--   replay   {success:true, replayed:true, order_id, status, created_at}
--            (same user + reference + network/volume/recipient; no money moves)
--   reuse    {success:false, error:'Reference reused with a different order',
--             code:'REFERENCE_REUSED'}   (no money moves)
--   balance  {success:false, error:'Insufficient balance', required, balance}
--   wallet   {success:false, error:'Wallet not found'}
--   failure  {success:false, error:'Order could not be placed'}
--            (bad parameters, a price that is not a positive whole-pesewa
--            amount, key not owned / not active / not live, package missing /
--            unavailable / not matching network+volume, price not one of the
--            package's tiers, or any unexpected error). SQLERRM is never
--            returned.
--
-- Check order: parameter guards -> key (locked FOR SHARE) -> reference
-- lookup (replay / REFERENCE_REUSED) -> package + price tier -> money path.
-- The package check runs AFTER the replay lookup on purpose: a replay moves
-- no money and must still answer if the package was later disabled or
-- repriced.
--
-- The money part mirrors place_api_order exactly (wallet FOR UPDATE, balance
-- check, deduct balance + total_spent, order insert, transactions debit row
-- with source 'api_order' and reference_id = order id), all inside one inner
-- block so any failure after the deduction rolls the deduction back.
--
-- Concurrency:
--   * The wallet row lock serialises every placement for one user (v1 and v2
--     both take it). After taking it the reference is looked up AGAIN, so a
--     second identical call that waited on the lock sees the first call's
--     committed order and returns the replay without charging.
--   * Two different references racing a balance that covers one: the second
--     re-reads the balance under the lock (READ COMMITTED re-fetch on FOR
--     UPDATE) and gets 'Insufficient balance'.
--   * Backstop: if the order insert still hits unique_violation
--     (unique_api_reference_per_user), the inner block is rolled back
--     (wallet deduction undone) and the handler returns replay or
--     REFERENCE_REUSED from a fresh lookup.
--   * Revocation: the key row is read FOR SHARE. A revoke that committed
--     first makes the re-evaluated row fail the status = 'active' test (no
--     order); a revoke that starts after we hold the lock waits for our
--     commit, so the order was placed before the revoke took effect.
--
-- Triggers on api_orders (checked 2026-10-23): trg_00_refund_status_guard is
-- BEFORE UPDATE only (status column); trg_capture_mtn_api_orders is AFTER
-- INSERT, reads network + recipient_phone via to_jsonb(NEW) and swallows its
-- own errors. Neither reads api_key_id, so a NULL api_key_id is safe.
--
-- SECURITY DEFINER with a pinned search_path, executable by service_role
-- only, same posture as 0128/0129.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. api_orders: v2 key attribution.
ALTER TABLE public.api_orders ALTER COLUMN api_key_id DROP NOT NULL;

-- NO ACTION, not RESTRICT: a v2 key that has orders still cannot be deleted
-- on its own, but NO ACTION is checked at the end of the statement, so a
-- cascading delete (an auth user removed, cascading to api_v2_keys) that also
-- removes the referencing api_orders rows in the same statement is not
-- blocked the way an immediate RESTRICT check would block it.
ALTER TABLE public.api_orders
  ADD COLUMN IF NOT EXISTS api_v2_key_id UUID
    CONSTRAINT api_orders_api_v2_key_id_fkey
    REFERENCES public.api_v2_keys(id) ON DELETE NO ACTION;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_orders_exactly_one_key'
      AND conrelid = 'public.api_orders'::regclass
  ) THEN
    ALTER TABLE public.api_orders
      ADD CONSTRAINT api_orders_exactly_one_key
      CHECK ((api_key_id IS NOT NULL) <> (api_v2_key_id IS NOT NULL)) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.api_orders VALIDATE CONSTRAINT api_orders_exactly_one_key;

CREATE INDEX IF NOT EXISTS api_orders_api_v2_key_id_idx
  ON public.api_orders (api_v2_key_id)
  WHERE api_v2_key_id IS NOT NULL;

-- 2. sandbox_orders: same split for v2 test keys.
ALTER TABLE public.sandbox_orders ALTER COLUMN api_key_id DROP NOT NULL;

ALTER TABLE public.sandbox_orders
  ADD COLUMN IF NOT EXISTS api_v2_key_id UUID
    CONSTRAINT sandbox_orders_api_v2_key_id_fkey
    REFERENCES public.api_v2_keys(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sandbox_orders_exactly_one_key'
      AND conrelid = 'public.sandbox_orders'::regclass
  ) THEN
    ALTER TABLE public.sandbox_orders
      ADD CONSTRAINT sandbox_orders_exactly_one_key
      CHECK ((api_key_id IS NOT NULL) <> (api_v2_key_id IS NOT NULL)) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.sandbox_orders VALIDATE CONSTRAINT sandbox_orders_exactly_one_key;

CREATE INDEX IF NOT EXISTS sandbox_orders_api_v2_key_id_idx
  ON public.sandbox_orders (api_v2_key_id)
  WHERE api_v2_key_id IS NOT NULL;

-- 3. Atomic, replay-aware placement.
CREATE OR REPLACE FUNCTION public.place_api_v2_order(
  p_user_id UUID,
  p_api_v2_key_id UUID,
  p_package_id UUID,
  p_network TEXT,
  p_volume_gb NUMERIC,
  p_price NUMERIC,
  p_recipient_phone TEXT,
  p_api_reference TEXT,
  p_description TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fail CONSTANT JSONB := jsonb_build_object('success', false, 'error', 'Order could not be placed');
  v_reused CONSTANT JSONB := jsonb_build_object(
    'success', false,
    'error', 'Reference reused with a different order',
    'code', 'REFERENCE_REUSED'
  );
  v_existing RECORD;
  v_old_balance NUMERIC;
  v_new_balance NUMERIC;
  v_order_id UUID;
  v_created_at TIMESTAMPTZ;
BEGIN
  -- 0. Defensive parameter checks. NaN and Infinity compare as > 0 in
  --    numeric, so they are rejected by text form (round() of them does not
  --    raise; any unexpected error lands in the generic-failure handler
  --    anyway). A zero or negative price must never reach the
  --    wallet update (it would credit the wallet). The wallet and
  --    transactions columns are DECIMAL(15,2) while api_orders.price is
  --    unbounded, so a sub-pesewa price (0.004 -> debit 0.00) or a 3-decimal
  --    price (4.555 -> debit 4.56) is refused instead of being rounded.
  IF p_user_id IS NULL
     OR p_api_v2_key_id IS NULL
     OR p_package_id IS NULL
     OR p_network IS NULL OR btrim(p_network) = ''
     OR p_volume_gb IS NULL
     OR p_volume_gb::text IN ('NaN', 'Infinity', '-Infinity')
     OR NOT (p_volume_gb > 0)
     OR p_price IS NULL
     OR p_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR NOT (p_price > 0)
     OR p_price < 0.01
     OR p_price <> round(p_price, 2)
     OR p_recipient_phone IS NULL OR btrim(p_recipient_phone) = ''
     OR p_api_reference IS NULL OR btrim(p_api_reference) = ''
  THEN
    RETURN v_fail;
  END IF;

  -- The key must belong to this user and be an active LIVE key. Test keys
  -- never touch the real wallet (they use sandbox_orders). FOR SHARE closes
  -- the revocation race (see header); it does not block other placements.
  PERFORM 1
  FROM public.api_v2_keys k
  WHERE k.id = p_api_v2_key_id
    AND k.user_id = p_user_id
    AND k.status = 'active'
    AND k.environment = 'live'
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN v_fail;
  END IF;

  -- 1. Fast path: the reference already exists for this user.
  SELECT o.id, o.network, o.volume_gb, o.recipient_phone, o.status, o.created_at
    INTO v_existing
  FROM public.api_orders o
  WHERE o.user_id = p_user_id AND o.api_reference = p_api_reference;

  IF FOUND THEN
    IF lower(v_existing.network) = lower(p_network)
       AND v_existing.volume_gb = p_volume_gb
       AND v_existing.recipient_phone = p_recipient_phone THEN
      RETURN jsonb_build_object(
        'success', true,
        'replayed', true,
        'order_id', v_existing.id,
        'status', v_existing.status,
        'created_at', v_existing.created_at
      );
    END IF;
    RETURN v_reused;
  END IF;

  -- 1b. Defence in depth: the package must exist, be available, and match
  --     the network and volume; the price must be one of its tiers (price,
  --     or dealer_price when > 0). The route resolves all of this already;
  --     this stops a buggy caller from inserting a mismatched or underpriced
  --     order. packages.size is TEXT ("1", "2", ...); the CASE guarantees the
  --     regex runs before the numeric cast (AND has no evaluation order).
  IF NOT EXISTS (
    SELECT 1
    FROM public.packages p
    WHERE p.id = p_package_id
      AND p.is_available = true
      AND lower(p.network) = lower(p_network)
      AND (CASE WHEN p.size ~ '^[0-9]+(\.[0-9]+)?$' THEN p.size::numeric END) = p_volume_gb
      AND (p_price = p.price OR (p.dealer_price > 0 AND p_price = p.dealer_price))
  ) THEN
    RETURN v_fail;
  END IF;

  -- 2. Money path, one inner block: any exception rolls back the deduction.
  BEGIN
    SELECT w.balance INTO v_old_balance
    FROM public.wallets w
    WHERE w.user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND OR v_old_balance IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Wallet not found');
    END IF;

    -- Re-check under the wallet lock: an identical call that held the lock
    -- before us has committed its order by now.
    SELECT o.id, o.network, o.volume_gb, o.recipient_phone, o.status, o.created_at
      INTO v_existing
    FROM public.api_orders o
    WHERE o.user_id = p_user_id AND o.api_reference = p_api_reference;

    IF FOUND THEN
      IF lower(v_existing.network) = lower(p_network)
         AND v_existing.volume_gb = p_volume_gb
         AND v_existing.recipient_phone = p_recipient_phone THEN
        RETURN jsonb_build_object(
          'success', true,
          'replayed', true,
          'order_id', v_existing.id,
          'status', v_existing.status,
          'created_at', v_existing.created_at
        );
      END IF;
      RETURN v_reused;
    END IF;

    IF v_old_balance < p_price THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Insufficient balance',
        'required', p_price,
        'balance', v_old_balance
      );
    END IF;

    v_new_balance := v_old_balance - p_price;

    UPDATE public.wallets
    SET balance = v_new_balance,
        total_spent = COALESCE(total_spent, 0) + p_price,
        updated_at = now()
    WHERE user_id = p_user_id;

    INSERT INTO public.api_orders (
      user_id,
      api_key_id,
      api_v2_key_id,
      package_id,
      network,
      volume_gb,
      price,
      recipient_phone,
      api_reference,
      status,
      created_at,
      updated_at
    )
    VALUES (
      p_user_id,
      NULL,
      p_api_v2_key_id,
      p_package_id,
      p_network,
      p_volume_gb,
      p_price,
      p_recipient_phone,
      p_api_reference,
      'pending',
      now(),
      now()
    )
    RETURNING id, created_at INTO v_order_id, v_created_at;

    INSERT INTO public.transactions (
      user_id,
      type,
      source,
      amount,
      balance_before,
      balance_after,
      description,
      reference_id,
      status,
      created_at
    )
    VALUES (
      p_user_id,
      'debit',
      'api_order',
      p_price,
      v_old_balance,
      v_new_balance,
      p_description,
      v_order_id::text,   -- transactions.reference_id is TEXT
      'completed',
      now()
    );

    RETURN jsonb_build_object(
      'success', true,
      'replayed', false,
      'order_id', v_order_id,
      'new_balance', v_new_balance,
      'created_at', v_created_at
    );

  EXCEPTION
    WHEN unique_violation THEN
      -- Race path. Everything in this block (including the wallet
      -- deduction) has been rolled back. Report what owns the reference.
      SELECT o.id, o.network, o.volume_gb, o.recipient_phone, o.status, o.created_at
        INTO v_existing
      FROM public.api_orders o
      WHERE o.user_id = p_user_id AND o.api_reference = p_api_reference;

      IF NOT FOUND THEN
        -- The violation came from another constraint; nothing was charged.
        RAISE LOG 'place_api_v2_order: unique_violation without a matching reference';
        RETURN v_fail;
      END IF;

      IF lower(v_existing.network) = lower(p_network)
         AND v_existing.volume_gb = p_volume_gb
         AND v_existing.recipient_phone = p_recipient_phone THEN
        RETURN jsonb_build_object(
          'success', true,
          'replayed', true,
          'order_id', v_existing.id,
          'status', v_existing.status,
          'created_at', v_existing.created_at
        );
      END IF;
      RETURN v_reused;
    WHEN OTHERS THEN
      -- SQLSTATE only: no message text, no parameters, no PII.
      RAISE LOG 'place_api_v2_order: failed with sqlstate %', SQLSTATE;
      RETURN v_fail;
  END;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'place_api_v2_order: failed with sqlstate %', SQLSTATE;
    RETURN v_fail;
END;
$$;

REVOKE ALL ON FUNCTION public.place_api_v2_order(uuid, uuid, uuid, text, numeric, numeric, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_api_v2_order(uuid, uuid, uuid, text, numeric, numeric, text, text, text)
  TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT table_name, column_name, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name IN ('api_orders', 'sandbox_orders')
--      AND column_name IN ('api_key_id', 'api_v2_key_id');            -- all YES
--   SELECT conrelid::regclass, conname, convalidated FROM pg_constraint
--    WHERE conname IN ('api_orders_exactly_one_key', 'sandbox_orders_exactly_one_key',
--                      'api_orders_api_v2_key_id_fkey', 'sandbox_orders_api_v2_key_id_fkey');
--   SELECT has_function_privilege('anon',
--            'public.place_api_v2_order(uuid,uuid,uuid,text,numeric,numeric,text,text,text)', 'EXECUTE'),
--          has_function_privilege('authenticated',
--            'public.place_api_v2_order(uuid,uuid,uuid,text,numeric,numeric,text,text,text)', 'EXECUTE');
--                                                                       -- both false
-- Self-test (self-rolling-back dry run): migrations/0130_api_v2_orders.selftest.sql
