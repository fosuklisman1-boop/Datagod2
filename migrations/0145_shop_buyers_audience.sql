-- 0145_shop_buyers_audience.sql
--
-- "Shop buyers" SMS broadcast audience (spec: docs/superpowers/specs/2026-11-02-shop-buyers-sms-broadcast-design.md).
-- ADDITIVE. Idempotent (re-runnable). Read-only functions + one admin table.
--
--   sms_marketing_opt_outs        admin "do not text" list for marketing SMS (phone_key = last 9 digits)
--   shop_buyer_audience(since, shop_ids)
--       one row per phone number: the shop of its MOST RECENT paid shop data order.
--       Phones = payer and recipient of every paid order:
--         shop_orders        customer_phone (+ payment_attempts.payer_phone, the MoMo payer, when linked)
--         ussd_shop_orders   dialing_phone (payer) and recipient_phone   [USSD + WhatsApp shop]
--       Excludes: unpaid orders, sub-agent stock purchases, invalid numbers, opted-out numbers,
--       inactive shops. The shop filter applies AFTER the latest-shop pick, so a buyer who moved
--       to another shop never appears under the old one.
--   shop_buyer_counts(since)      buyers per shop over the same audience.
--
-- Both functions are SECURITY DEFINER and executable by service_role only (admin API routes).

CREATE TABLE IF NOT EXISTS public.sms_marketing_opt_outs (
  phone_key  text PRIMARY KEY CHECK (phone_key ~ '^[0-9]{9}$'),
  reason     text,
  added_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sms_marketing_opt_outs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_marketing_opt_outs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.shop_buyer_audience(
  p_since    timestamptz DEFAULT NULL,
  p_shop_ids uuid[]      DEFAULT NULL
)
RETURNS TABLE (phone_key text, shop_id uuid, last_purchase_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH purchases AS (
    -- Storefront: the contact/recipient number on the order.
    SELECT o.customer_phone AS phone, o.shop_id, o.created_at AS paid_at
    FROM public.shop_orders o
    WHERE o.payment_status = 'completed'
      AND COALESCE(o.is_stock_purchase, false) = false
      AND (p_since IS NULL OR o.created_at >= p_since)
    UNION ALL
    -- Storefront: the MoMo payer, when the payment attempt recorded it.
    SELECT pa.payer_phone, o.shop_id, o.created_at
    FROM public.shop_orders o
    JOIN public.payment_attempts pa ON pa.order_id = o.id AND pa.payment_type = 'shop_order'
    WHERE o.payment_status = 'completed'
      AND COALESCE(o.is_stock_purchase, false) = false
      AND pa.payer_phone IS NOT NULL
      AND (p_since IS NULL OR o.created_at >= p_since)
    UNION ALL
    -- USSD / WhatsApp shop: payer (dialing) and recipient.
    SELECT u.dialing_phone, u.shop_id, u.created_at
    FROM public.ussd_shop_orders u
    WHERE u.payment_status = 'completed'
      AND (p_since IS NULL OR u.created_at >= p_since)
    UNION ALL
    SELECT u.recipient_phone, u.shop_id, u.created_at
    FROM public.ussd_shop_orders u
    WHERE u.payment_status = 'completed'
      AND (p_since IS NULL OR u.created_at >= p_since)
  ),
  keyed AS (
    SELECT right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9) AS phone_key, shop_id, paid_at
    FROM purchases
  ),
  latest AS (
    SELECT DISTINCT ON (k.phone_key) k.phone_key, k.shop_id, k.paid_at
    FROM keyed k
    WHERE k.phone_key ~ '^[25][0-9]{8}$'
    ORDER BY k.phone_key, k.paid_at DESC, k.shop_id
  )
  SELECT l.phone_key, l.shop_id, l.paid_at
  FROM latest l
  JOIN public.user_shops s ON s.id = l.shop_id AND s.is_active IS TRUE
  WHERE NOT EXISTS (SELECT 1 FROM public.sms_marketing_opt_outs x WHERE x.phone_key = l.phone_key)
    AND (p_shop_ids IS NULL OR l.shop_id = ANY (p_shop_ids))
  ORDER BY l.phone_key
$$;

CREATE OR REPLACE FUNCTION public.shop_buyer_counts(p_since timestamptz DEFAULT NULL)
RETURNS TABLE (shop_id uuid, buyers bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.shop_id, count(*)::bigint
  FROM public.shop_buyer_audience(p_since, NULL) a
  GROUP BY a.shop_id
  ORDER BY count(*) DESC, a.shop_id
$$;

REVOKE ALL ON FUNCTION public.shop_buyer_audience(timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shop_buyer_counts(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shop_buyer_audience(timestamptz, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.shop_buyer_counts(timestamptz) TO service_role;

-- Verify after apply:
--   SELECT count(*) FROM public.shop_buyer_audience();          -- total shop buyers
--   SELECT * FROM public.shop_buyer_counts() LIMIT 10;           -- biggest shops
--   SELECT has_function_privilege('authenticated', 'public.shop_buyer_audience(timestamptz,uuid[])', 'EXECUTE'); -- false
