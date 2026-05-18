-- Add USSD orders to combined_orders_view so they appear on the
-- admin order-payment-status page.
-- Run this in Supabase SQL editor after deploying the USSD feature.

DROP VIEW IF EXISTS combined_orders_view;

CREATE OR REPLACE VIEW combined_orders_view AS

-- 1. Bulk Orders
SELECT
    o.id::text                                                  AS id,
    o.created_at                                                AS created_at,
    o.phone_number                                              AS phone_number,
    o.price                                                     AS price,
    CASE
        WHEN LOWER(o.network) = 'mtn'                          THEN 'MTN'
        WHEN LOWER(o.network) = 'telecel'                      THEN 'Telecel'
        WHEN LOWER(o.network) = 'at'                           THEN 'AT'
        WHEN LOWER(o.network) IN ('at - ishare', 'ishare')    THEN 'AT - iShare'
        WHEN LOWER(o.network) = 'at - bigtime'                 THEN 'AT - BigTime'
        ELSE UPPER(o.network)
    END                                                         AS network,
    o.status                                                    AS status,
    'completed'                                                 AS payment_status,
    COALESCE(o.transaction_code, o.order_code, '-')             AS payment_reference,
    o.size::text                                                AS volume_gb,
    'bulk'                                                      AS type,
    NULL::text                                                  AS customer_email,
    NULL::text                                                  AS store_name,
    o.user_id                                                   AS shop_owner_id,
    u.email                                                     AS shop_owner_email
FROM orders o
LEFT JOIN users u ON o.user_id = u.id

UNION ALL

-- 2. API Orders
SELECT
    ao.id::text                                                 AS id,
    ao.created_at                                               AS created_at,
    ao.recipient_phone                                          AS phone_number,
    ao.price                                                    AS price,
    CASE
        WHEN LOWER(ao.network) = 'mtn'                         THEN 'MTN'
        WHEN LOWER(ao.network) = 'telecel'                     THEN 'Telecel'
        WHEN LOWER(ao.network) = 'at'                          THEN 'AT'
        WHEN LOWER(ao.network) IN ('at - ishare', 'ishare')   THEN 'AT - iShare'
        WHEN LOWER(ao.network) = 'at - bigtime'                THEN 'AT - BigTime'
        ELSE UPPER(ao.network)
    END                                                         AS network,
    ao.status                                                   AS status,
    'completed'                                                 AS payment_status,
    ao.api_reference                                            AS payment_reference,
    ao.volume_gb::text                                          AS volume_gb,
    'api'                                                       AS type,
    NULL::text                                                  AS customer_email,
    NULL::text                                                  AS store_name,
    ao.user_id                                                  AS shop_owner_id,
    u.email                                                     AS shop_owner_email
FROM api_orders ao
LEFT JOIN users u ON ao.user_id = u.id

UNION ALL

-- 3. Shop Orders (only completed payments)
SELECT
    so.id::text                                                 AS id,
    so.created_at                                               AS created_at,
    so.customer_phone                                           AS phone_number,
    so.total_price                                              AS price,
    CASE
        WHEN LOWER(so.network) = 'mtn'                         THEN 'MTN'
        WHEN LOWER(so.network) = 'telecel'                     THEN 'Telecel'
        WHEN LOWER(so.network) = 'at'                          THEN 'AT'
        WHEN LOWER(so.network) IN ('at - ishare', 'ishare')   THEN 'AT - iShare'
        WHEN LOWER(so.network) = 'at - bigtime'                THEN 'AT - BigTime'
        ELSE UPPER(so.network)
    END                                                         AS network,
    so.order_status                                             AS status,
    so.payment_status                                           AS payment_status,
    COALESCE(so.transaction_id, so.reference_code, '-')         AS payment_reference,
    so.volume_gb::text                                          AS volume_gb,
    'shop'                                                      AS type,
    so.customer_email                                           AS customer_email,
    us.shop_name                                                AS store_name,
    us.user_id                                                  AS shop_owner_id,
    u.email                                                     AS shop_owner_email
FROM shop_orders so
LEFT JOIN user_shops us ON so.shop_id = us.id
LEFT JOIN users u ON us.user_id = u.id
WHERE so.payment_status = 'completed'

UNION ALL

-- 4. USSD Orders (only completed payments — dialing_phone paid, recipient_phone receives)
SELECT
    uo.id::text                                                 AS id,
    uo.created_at                                               AS created_at,
    uo.recipient_phone                                          AS phone_number,
    uo.amount                                                   AS price,
    CASE
        WHEN LOWER(uo.network) = 'mtn'                         THEN 'MTN'
        WHEN LOWER(uo.network) = 'telecel'                     THEN 'Telecel'
        WHEN LOWER(uo.network) IN ('at-ishare', 'at - ishare') THEN 'AT - iShare'
        WHEN LOWER(uo.network) = 'airteltigo'                  THEN 'AirtelTigo'
        ELSE uo.network
    END                                                         AS network,
    uo.order_status                                             AS status,
    uo.payment_status                                           AS payment_status,
    COALESCE(uo.paystack_reference, uo.id::text)                AS payment_reference,
    uo.package_size                                             AS volume_gb,
    'ussd'                                                      AS type,
    NULL::text                                                  AS customer_email,
    NULL::text                                                  AS store_name,
    NULL::uuid                                                  AS shop_owner_id,
    NULL::text                                                  AS shop_owner_email
FROM ussd_orders uo
WHERE uo.payment_status = 'completed';
