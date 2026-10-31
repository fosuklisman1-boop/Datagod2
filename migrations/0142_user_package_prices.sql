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
--     Errors: RAISE EXCEPTION 'BAD_INPUT' (detail says why) and nothing is written.

BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'role';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_pricing_mode_check') THEN
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
  v_new      numeric(10,2);
  v_old      numeric(10,2);
  v_changed  integer := 0;
BEGIN
  IF p_admin IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'admin and user are required';
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
      v_pkg := (v_item->>'package_id')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.packages WHERE id = v_pkg) THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown package';
      END IF;

      SELECT price INTO v_old FROM public.user_package_prices WHERE user_id = p_user AND package_id = v_pkg;
      IF NOT FOUND THEN v_old := NULL; END IF;

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

COMMIT;

-- Verify after apply:
--   SELECT pricing_mode, count(*) FROM public.users GROUP BY 1;              -- all 'role'
--   SELECT count(*) FROM public.user_package_prices;                          -- 0
--   SELECT has_function_privilege('authenticated', 'public.set_user_custom_prices(uuid,uuid,text,jsonb)', 'EXECUTE'); -- false
