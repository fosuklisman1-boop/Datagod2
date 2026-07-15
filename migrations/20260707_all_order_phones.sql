-- All-time order phone export: union all 9 order tables into one read-only view,
-- normalize phone format + canonicalize network, and expose a pre-aggregated
-- JSONB accessor. Read-only; does not touch the fulfillment combined_orders_view.

-- 1. Phone normalizer: mirrors lib/phone-format.ts (canonical local 0XXXXXXXXX),
--    returns NULL for anything that isn't a plausible Ghana mobile number.
CREATE OR REPLACE FUNCTION normalize_gh_phone(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH d AS (
    SELECT regexp_replace(COALESCE(raw, ''), '\D', '', 'g') AS digits
  ),
  sig AS (
    SELECT CASE
      WHEN digits LIKE '233%' THEN substring(digits FROM 4)
      WHEN digits LIKE '0%'   THEN substring(digits FROM 2)
      ELSE digits
    END AS s
    FROM d
  )
  SELECT CASE WHEN s ~ '^[2-9][0-9]{8}$' THEN '0' || s ELSE NULL END
  FROM sig;
$$;

-- 2. Union view. network_raw is canonicalized here; NULL for the no-network tables.
DROP VIEW IF EXISTS all_order_phones;
CREATE VIEW all_order_phones WITH (security_invoker = true) AS
SELECT 'orders'::text AS source_table, 'data'::text AS product_type,
       normalize_gh_phone(o.phone_number) AS phone, o.phone_number AS phone_original,
       CASE
         WHEN LOWER(o.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(o.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(o.network) IN ('at','airteltigo') THEN 'AT'
         WHEN LOWER(o.network) IN ('at - ishare','at-ishare','ishare') THEN 'AT - iShare'
         WHEN LOWER(o.network) IN ('at - bigtime','at-bigtime','bigtime') THEN 'AT - BigTime'
         ELSE UPPER(o.network)
       END AS network_raw,
       o.created_at
FROM orders o
UNION ALL
SELECT 'shop_orders', 'data',
       normalize_gh_phone(so.customer_phone), so.customer_phone,
       CASE
         WHEN LOWER(so.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(so.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(so.network) IN ('at','airteltigo') THEN 'AT'
         WHEN LOWER(so.network) IN ('at - ishare','at-ishare','ishare') THEN 'AT - iShare'
         WHEN LOWER(so.network) IN ('at - bigtime','at-bigtime','bigtime') THEN 'AT - BigTime'
         ELSE UPPER(so.network)
       END,
       so.created_at
FROM shop_orders so
UNION ALL
SELECT 'api_orders', 'data',
       normalize_gh_phone(ao.recipient_phone), ao.recipient_phone,
       CASE
         WHEN LOWER(ao.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(ao.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(ao.network) IN ('at','airteltigo') THEN 'AT'
         WHEN LOWER(ao.network) IN ('at - ishare','at-ishare','ishare') THEN 'AT - iShare'
         WHEN LOWER(ao.network) IN ('at - bigtime','at-bigtime','bigtime') THEN 'AT - BigTime'
         ELSE UPPER(ao.network)
       END,
       ao.created_at
FROM api_orders ao
UNION ALL
SELECT 'ussd_orders', 'data',
       normalize_gh_phone(uo.recipient_phone), uo.recipient_phone,
       CASE
         WHEN LOWER(uo.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(uo.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(uo.network) IN ('at','airteltigo') THEN 'AT'
         WHEN LOWER(uo.network) IN ('at - ishare','at-ishare','ishare') THEN 'AT - iShare'
         WHEN LOWER(uo.network) IN ('at - bigtime','at-bigtime','bigtime') THEN 'AT - BigTime'
         ELSE UPPER(uo.network)
       END,
       uo.created_at
FROM ussd_orders uo
UNION ALL
SELECT 'ussd_shop_orders', 'data',
       normalize_gh_phone(uso.recipient_phone), uso.recipient_phone,
       CASE
         WHEN LOWER(uso.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(uso.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(uso.network) IN ('at','airteltigo') THEN 'AT'
         WHEN LOWER(uso.network) IN ('at - ishare','at-ishare','ishare') THEN 'AT - iShare'
         WHEN LOWER(uso.network) IN ('at - bigtime','at-bigtime','bigtime') THEN 'AT - BigTime'
         ELSE UPPER(uso.network)
       END,
       uso.created_at
FROM ussd_shop_orders uso
UNION ALL
SELECT 'airtime_orders', 'airtime',
       normalize_gh_phone(air.beneficiary_phone), air.beneficiary_phone,
       CASE
         WHEN LOWER(air.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(air.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(air.network) IN ('at','airteltigo') THEN 'AT'
         ELSE UPPER(air.network)
       END,
       air.created_at
FROM airtime_orders air
UNION ALL
SELECT 'afa_orders', 'afa',
       normalize_gh_phone(afa.phone_number), afa.phone_number,
       NULL::text,
       afa.created_at
FROM afa_orders afa
UNION ALL
SELECT 'ussd_afa_orders', 'afa',
       normalize_gh_phone(ua.dialing_phone), ua.dialing_phone,
       NULL::text,
       ua.created_at
FROM ussd_afa_orders ua
UNION ALL
SELECT 'results_checker_orders', 'results',
       normalize_gh_phone(rc.customer_phone), rc.customer_phone,
       NULL::text,
       rc.created_at
FROM results_checker_orders rc;

-- 3. Pre-aggregated accessor: one row per (source, network_raw, phone), returned
--    as a single JSONB array so the route reads it in one PostgREST call.
CREATE OR REPLACE FUNCTION get_all_order_phones()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  FROM (
    SELECT
      source_table,
      product_type,
      network_raw,
      COALESCE(phone, phone_original) AS phone,
      (phone IS NOT NULL) AS normalized,
      COUNT(*)            AS order_count,
      MIN(created_at)     AS first_order_at,
      MAX(created_at)     AS last_order_at
    FROM all_order_phones
    WHERE COALESCE(phone, phone_original) IS NOT NULL
    GROUP BY source_table, product_type, network_raw,
             COALESCE(phone, phone_original), (phone IS NOT NULL)
  ) t;
$$;

-- Lock down: the export route uses the service role (bypasses RLS). No other
-- role may read customer phone numbers in bulk through these objects.
REVOKE ALL ON FUNCTION get_all_order_phones() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION get_all_order_phones() TO service_role;
REVOKE ALL ON FUNCTION normalize_gh_phone(text)  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION normalize_gh_phone(text) TO service_role;
REVOKE ALL ON all_order_phones FROM anon, authenticated;
GRANT  SELECT ON all_order_phones TO service_role;
