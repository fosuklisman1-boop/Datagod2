-- 0185_role_price_sql.sql
--
-- Custom roles, Phase 2a Task 5: the SQL twin of lib/roles/ladder.ts (role_price_for) and ONE additive acceptance clause in
-- place_api_v2_order so a live API v2 purchase at the caller's role-ladder price is accepted. ADDITIVE; NOT applied by the
-- implementing agent. One transaction. Idempotent (CREATE OR REPLACE; re-runnable).
--
--   role_price_for(p_role text, p_package uuid) RETURNS numeric   STABLE, SECURITY DEFINER, search_path = public
--     Walks the ladder: the role itself (if non-archived), then non-archived roles with rank strictly lower, by rank desc.
--     Off-ladder role (rank NULL) -> itself only. Unknown / archived / NULL role -> no roles. First role_package_prices.price
--     found; else packages.price. NULL when the package does not exist.
--   place_api_v2_order: body identical to migrations/0142_user_package_prices.sql (== the live definition, see PRE-CHECKS)
--     except the 1b price-acceptance condition gains ONE disjunct:
--         OR p_price = public.role_price_for((SELECT u2.role FROM public.users u2 WHERE u2.id = p_user_id), p.id)
--     Nothing currently accepted is removed. Grants repeat 0142's (service_role only), so the ACL is unchanged.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT md5(pg_get_functiondef('public.place_api_v2_order(uuid,uuid,uuid,text,numeric,numeric,text,text,text)'::regprocedure));  -- must be 66cfbadfaa07b8fddfa30ccd3f191921
--   SELECT to_regclass('public.roles');  -- NOT NULL (0184 applied)
--   -- Do NOT insert any non-system roles row until Phase 2 is complete (lib/roles/flags.ts).
--
-- Dry run: migrations/0185_role_price_sql.selftest.sql (build the run string by code, as lib/roles/migration-0185.test.ts does).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ============ role_price_for ============
CREATE OR REPLACE FUNCTION public.role_price_for(p_role text, p_package uuid) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn_rpf$
DECLARE
  v_pkg_price numeric;
  v_self_id   uuid;
  v_self_rank int;
  v_price     numeric;
BEGIN
  IF p_package IS NULL THEN RETURN NULL; END IF;
  SELECT p.price INTO v_pkg_price FROM public.packages p WHERE p.id = p_package;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF p_role IS NOT NULL THEN
    SELECT r.id, r.rank INTO v_self_id, v_self_rank
      FROM public.roles r WHERE r.slug = p_role AND r.archived_at IS NULL;
    IF FOUND THEN
      -- the role itself first, then strictly lower-ranked non-archived roles by rank desc (off-ladder: itself only)
      SELECT rpp.price INTO v_price
        FROM public.role_package_prices rpp
        JOIN public.roles r ON r.id = rpp.role_id
       WHERE rpp.package_id = p_package
         AND rpp.price > 0
         AND (r.id = v_self_id
              OR (v_self_rank IS NOT NULL AND r.archived_at IS NULL AND r.rank IS NOT NULL AND r.rank < v_self_rank))
       ORDER BY (r.id = v_self_id) DESC, r.rank DESC NULLS LAST
       LIMIT 1;
      IF v_price IS NOT NULL THEN RETURN v_price; END IF;
    END IF;
  END IF;
  RETURN v_pkg_price;
END $fn_rpf$;

REVOKE ALL ON FUNCTION public.role_price_for(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.role_price_for(text, uuid) TO service_role;

-- ============ place_api_v2_order (0142 body + one disjunct) ============
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
  --     dealer_price when > 0, the user's custom price, or the caller's
  --     role-ladder price via role_price_for). The route resolves all of this already;
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
                     AND upp.package_id = p.id AND upp.price = p_price)
        OR p_price = public.role_price_for((SELECT u2.role FROM public.users u2 WHERE u2.id = p_user_id), p.id))
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
