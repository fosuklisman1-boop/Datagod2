-- MTN registry prefix fix (post-review of the first export):
-- Numbers from orders whose network column said 'MTN' but whose actual prefix
-- is Telecel/AT/invalid (mistaken-network orders — 411 found in prod) must not
-- be exported to the provider. Classify at capture time and purge existing ones.
--
-- 'rejected' semantics: never exported (claim takes only 'pending'), never
-- re-admitted (ON CONFLICT DO NOTHING), and the Phase 2 gate PASSES rejected
-- numbers through to the provider (fail-fast into the manual queue) instead of
-- holding them forever for an activation that will never come.
-- Depends on: gh_is_mtn(text) + mtn_number_registry from 20260707_mtn_number_registry.sql.

-- 1. Capture trigger: classify by prefix instead of always inserting 'pending'.
CREATE OR REPLACE FUNCTION capture_mtn_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER                 -- insert succeeds regardless of writer's role
SET search_path = public
AS $$
DECLARE
  j    jsonb := to_jsonb(NEW);
  raw  text;
  norm text;
BEGIN
  IF lower(COALESCE(j->>'network','')) <> 'mtn' THEN
    RETURN NEW;
  END IF;
  raw := CASE TG_TABLE_NAME
    WHEN 'orders'      THEN j->>'phone_number'
    WHEN 'shop_orders' THEN j->>'customer_phone'
    ELSE                    j->>'recipient_phone'   -- api_orders / ussd_orders / ussd_shop_orders
  END;
  norm := normalize_gh_phone(raw);
  IF norm IS NULL THEN
    RETURN NEW;
  END IF;
  -- Never revives a registered/rejected row; idempotent on repeat orders.
  -- Non-MTN prefix (mistaken-network order) enrolls as 'rejected', not 'pending'.
  INSERT INTO mtn_number_registry (phone, source, status, notes)
  VALUES (
    norm,
    'order:' || TG_TABLE_NAME,
    CASE WHEN gh_is_mtn(norm) THEN 'pending' ELSE 'rejected' END,
    CASE WHEN gh_is_mtn(norm) THEN NULL ELSE 'non-MTN prefix at capture' END
  )
  ON CONFLICT (phone) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;                    -- best-effort: never break the order write
END;
$$;
REVOKE ALL ON FUNCTION capture_mtn_number() FROM PUBLIC, anon, authenticated;

-- 2. Purge existing non-MTN-prefix rows from the exportable set (idempotent).
--    Only touches pending/submitted — never registered (provider-confirmed).
UPDATE mtn_number_registry
SET status = 'rejected',
    notes = 'non-MTN prefix (mistaken-network order)',
    updated_at = now()
WHERE status IN ('pending', 'submitted')
  AND NOT gh_is_mtn(phone);
