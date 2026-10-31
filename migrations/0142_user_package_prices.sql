-- 0142_user_package_prices.sql
--
-- Per-user custom data bundle prices (spec: docs/superpowers/specs/2026-10-31-per-user-custom-prices-design.md).
-- ADDITIVE. Idempotent (re-runnable). One transaction. NOT applied by the implementing agent.
--
--   users.pricing_mode   'role' (default: normal role pricing) | 'custom' (saved custom prices apply)
--   user_package_prices  one fixed price per (user, package); a package with no row uses the role price
--   set_user_custom_prices(p_admin, p_user, p_mode, p_prices)  the ONLY write path (service role):
--     p_mode    'role' | 'custom' | NULL (NULL = leave the mode as it is)
--     p_prices  jsonb array of {"package_id": uuid, "price": number|null}; null deletes that custom price.
--               NULL or [] = no price changes.
--     Writes one admin_audit_log row per actual change. Returns {"changed": <int>}.
--     Errors: RAISE EXCEPTION 'BAD_INPUT' (detail says why) and nothing is written. Cases: missing admin/user,
--     unknown admin, unknown user, bad mode, prices not an array, bad item shape, package_id not a uuid,
--     unknown package, package listed twice, price not a number or out of range / more than 2 decimals.

BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'role';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_pricing_mode_check' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_pricing_mode_check CHECK (pricing_mode IN ('role', 'custom'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_package_prices (
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES public.packages(id) ON DELETE CASCADE,
  price      numeric(10,2) NOT NULL CHECK (price > 0 AND price <= 10000),
  set_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, package_id)
);

ALTER TABLE public.user_package_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own custom prices" ON public.user_package_prices;
CREATE POLICY "Users read own custom prices" ON public.user_package_prices
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- Users must not switch themselves to custom pricing. Same SECURITY DEFINER pattern as 0045
-- (a subquery on public.users inside the policy would recurse).
CREATE OR REPLACE FUNCTION public.get_current_user_pricing_mode()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT pricing_mode FROM public.users WHERE id = auth.uid()
$$;

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE
  USING (id = (SELECT auth.uid()))
  WITH CHECK (
    id = (SELECT auth.uid())
    AND role = public.get_current_user_role()
    AND pricing_mode = public.get_current_user_pricing_mode()
  );

CREATE OR REPLACE FUNCTION public.set_user_custom_prices(
  p_admin uuid,
  p_user uuid,
  p_mode text,
  p_prices jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_old_mode text;
  v_item     jsonb;
  v_pkg      uuid;
  v_new      numeric;
  v_old      numeric(10,2);
  v_changed  integer := 0;
  v_seen     uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_admin IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'admin and user are required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_admin) THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown admin';
  END IF;

  -- Lock the user row: concurrent saves for one user run one after the other.
  SELECT pricing_mode INTO v_old_mode FROM public.users WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'user not found';
  END IF;

  IF p_mode IS NOT NULL THEN
    IF p_mode NOT IN ('role', 'custom') THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'pricing_mode must be role or custom';
    END IF;
    IF p_mode <> v_old_mode THEN
      UPDATE public.users SET pricing_mode = p_mode WHERE id = p_user;
      INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
      VALUES (p_admin, 'pricing_mode_set', p_user,
              jsonb_build_object('pricing_mode', v_old_mode), jsonb_build_object('pricing_mode', p_mode));
      v_changed := v_changed + 1;
    END IF;
  END IF;

  IF p_prices IS NOT NULL THEN
    IF jsonb_typeof(p_prices) <> 'array' THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'prices must be an array';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_prices) LOOP
      IF jsonb_typeof(v_item) <> 'object' OR NOT (v_item ? 'package_id') OR NOT (v_item ? 'price') THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'each price needs package_id and price';
      END IF;
      IF jsonb_typeof(v_item->'package_id') <> 'string'
         OR v_item->>'package_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'package_id must be a uuid';
      END IF;
      v_pkg := (v_item->>'package_id')::uuid;
      IF v_pkg = ANY (v_seen) THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'package listed twice';
      END IF;
      v_seen := v_seen || v_pkg;
      IF NOT EXISTS (SELECT 1 FROM public.packages WHERE id = v_pkg) THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown package';
      END IF;

      v_old := NULL;
      SELECT price INTO v_old FROM public.user_package_prices WHERE user_id = p_user AND package_id = v_pkg;

      IF jsonb_typeof(v_item->'price') = 'null' THEN
        IF v_old IS NOT NULL THEN
          DELETE FROM public.user_package_prices WHERE user_id = p_user AND package_id = v_pkg;
          INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
          VALUES (p_admin, 'custom_price_removed', p_user,
                  jsonb_build_object('package_id', v_pkg, 'price', v_old), NULL);
          v_changed := v_changed + 1;
        END IF;
      ELSE
        IF jsonb_typeof(v_item->'price') <> 'number' THEN
          RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'price must be a number or null';
        END IF;
        v_new := (v_item->>'price')::numeric;
        IF v_new <= 0 OR v_new > 10000 OR v_new <> round(v_new, 2) THEN
          RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'price must be > 0, <= 10000, at most 2 decimals';
        END IF;
        IF v_old IS DISTINCT FROM v_new THEN
          INSERT INTO public.user_package_prices (user_id, package_id, price, set_by)
          VALUES (p_user, v_pkg, v_new, p_admin)
          ON CONFLICT (user_id, package_id)
          DO UPDATE SET price = EXCLUDED.price, set_by = EXCLUDED.set_by, updated_at = now();
          INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
          VALUES (p_admin, 'custom_price_set', p_user,
                  CASE WHEN v_old IS NULL THEN NULL ELSE jsonb_build_object('package_id', v_pkg, 'price', v_old) END,
                  jsonb_build_object('package_id', v_pkg, 'price', v_new));
          v_changed := v_changed + 1;
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('changed', v_changed);
END
$fn$;

REVOKE ALL ON FUNCTION public.set_user_custom_prices(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_custom_prices(uuid, uuid, text, jsonb) TO service_role;

-- Redefine place_api_v2_order (copy of 0130) so its price re-check also accepts
-- the user's custom price. Without this, a live v2 purchase at a custom price
-- matches neither price nor dealer_price and fails. Only that condition differs.
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
      AND (p_price = p.price OR (p.dealer_price > 0 AND p_price = p.dealer_price)
        OR EXISTS (SELECT 1 FROM public.users u
                   JOIN public.user_package_prices upp ON upp.user_id = u.id
                   WHERE u.id = p_user_id AND u.pricing_mode = 'custom'
                     AND upp.package_id = p.id AND upp.price = p_price))
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

-- Verify after apply:
--   SELECT pricing_mode, count(*) FROM public.users GROUP BY 1;              -- all 'role'
--   SELECT count(*) FROM public.user_package_prices;                          -- 0
--   SELECT has_function_privilege('authenticated', 'public.set_user_custom_prices(uuid,uuid,text,jsonb)', 'EXECUTE'); -- false
