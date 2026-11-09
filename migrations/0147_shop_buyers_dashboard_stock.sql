-- 0147_shop_buyers_dashboard_stock.sql
--
-- Widen the "Shop buyers" broadcast audience (0145) to the buyers a shop's Customers page
-- already counts but the audience missed:
--   orders            dealer dashboard purchases (single + bulk), attributed to the buyer's own
--                     shop via user_shops.user_id. Rows are inserted after the wallet debit, so
--                     every row is paid; refunded rows are excluded.
--   shop_orders       sub-agent stock purchases are no longer excluded: shop_id is the
--                     sub-agent's own shop and customer_phone is that sub-agent's customer.
--   owner's own number is no longer counted as a buyer of their own shop (it still counts for
--                     any other shop they bought from), so owners aren't texted their own shop.
-- Before this, dealers who sell from the dashboard showed e.g. 675 customers but 3 buyers.
--
-- ADDITIVE. Idempotent (re-runnable). Replaces shop_buyer_audience() only; shop_buyer_counts()
-- reads it and picks up the change. Same signature, same service_role-only grants.

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
    -- Storefront and sub-agent stock purchases: the contact/recipient number on the order.
    SELECT o.customer_phone AS phone, o.shop_id, o.created_at AS paid_at
    FROM public.shop_orders o
    WHERE o.payment_status = 'completed'
      AND (p_since IS NULL OR o.created_at >= p_since)
    UNION ALL
    -- Storefront: the MoMo payer, when the payment attempt recorded it.
    SELECT pa.payer_phone, o.shop_id, o.created_at
    FROM public.shop_orders o
    JOIN public.payment_attempts pa ON pa.order_id = o.id AND pa.payment_type = 'shop_order'
    WHERE o.payment_status = 'completed'
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
    UNION ALL
    -- Dealer dashboard purchases (wallet-paid), under the buyer's own shop.
    SELECT d.phone_number, s.id, d.created_at
    FROM public.orders d
    JOIN public.user_shops s ON s.user_id = d.user_id
    WHERE d.status IS DISTINCT FROM 'refunded'
      AND (p_since IS NULL OR d.created_at >= p_since)
  ),
  owner_keys AS (
    SELECT s.id AS shop_id, right(regexp_replace(coalesce(u.phone_number, ''), '\D', '', 'g'), 9) AS phone_key
    FROM public.user_shops s
    JOIN public.users u ON u.id = s.user_id
  ),
  keyed AS (
    SELECT k.* FROM (
      SELECT right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9) AS phone_key, shop_id, paid_at
      FROM purchases
    ) k
    -- A shop owner's own number (dashboard self top-ups) is never a buyer of their own shop.
    WHERE NOT EXISTS (SELECT 1 FROM owner_keys ok WHERE ok.shop_id = k.shop_id AND ok.phone_key = k.phone_key)
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

REVOKE ALL ON FUNCTION public.shop_buyer_audience(timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shop_buyer_audience(timestamptz, uuid[]) TO service_role;

-- Verify after apply:
--   SELECT count(*) FROM public.shop_buyer_audience();          -- was 15,564 before 0147
--   SELECT * FROM public.shop_buyer_counts() LIMIT 10;
--   SELECT has_function_privilege('authenticated', 'public.shop_buyer_audience(timestamptz,uuid[])', 'EXECUTE'); -- false
