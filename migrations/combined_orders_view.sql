-- Drop the view if it exists to allow for renaming columns and changing structures
DROP VIEW IF EXISTS combined_orders_view;

-- Create a unified view for all order types with column names matching the frontend expectations
-- This version uses explicit aliases for all columns to ensure compatibility across all branches
CREATE OR REPLACE VIEW combined_orders_view AS
-- 1. Bulk Orders
SELECT 
    o.id::text as id,
    o.created_at as created_at,
    o.phone_number as phone_number,
    o.price as price,
    CASE 
        WHEN LOWER(o.network) = 'mtn' THEN 'MTN'
        WHEN LOWER(o.network) = 'telecel' THEN 'Telecel'
        WHEN LOWER(o.network) = 'at' THEN 'AT'
        WHEN LOWER(o.network) IN ('at - ishare', 'ishare') THEN 'AT - iShare'
        WHEN LOWER(o.network) = 'at - bigtime' THEN 'AT - BigTime'
        ELSE UPPER(o.network)
    END as network,
    o.status as status,
    'completed' as payment_status,
    COALESCE(o.transaction_code, o.order_code, '-') as payment_reference,
    o.size::text as volume_gb,
    'bulk' as type,
    NULL as customer_email,
    NULL as store_name,
    NULL as shop_owner_id,
    NULL as shop_owner_email
FROM orders o

UNION ALL

-- 2. Shop Orders (Only completed payments)
SELECT 
    so.id::text as id,
    so.created_at as created_at,
    so.customer_phone as phone_number,
    so.total_price as price,
    CASE 
        WHEN LOWER(so.network) = 'mtn' THEN 'MTN'
        WHEN LOWER(so.network) = 'telecel' THEN 'Telecel'
        WHEN LOWER(so.network) = 'at' THEN 'AT'
        WHEN LOWER(so.network) IN ('at - ishare', 'ishare') THEN 'AT - iShare'
        WHEN LOWER(so.network) = 'at - bigtime' THEN 'AT - BigTime'
        ELSE UPPER(so.network)
    END as network,
    so.order_status as status,
    so.payment_status as payment_status,
    COALESCE(so.transaction_id, so.reference_code, '-') as payment_reference,
    so.volume_gb::text as volume_gb,
    'shop' as type,
    so.customer_email as customer_email,
    us.shop_name as store_name,
    us.user_id as shop_owner_id,
    u.email as shop_owner_email
FROM shop_orders so
LEFT JOIN user_shops us ON so.shop_id = us.id
LEFT JOIN users u ON us.user_id = u.id
WHERE so.payment_status = 'completed'

UNION ALL

-- 3. Wallet Top-ups
SELECT 
    wp.id::text as id,
    wp.created_at as created_at,
    '-' as phone_number,
    wp.amount as price,
    'Wallet Top-up' as network,
    wp.status as status,
    'completed' as payment_status,
    COALESCE(wp.reference, '-') as payment_reference,
    '0' as volume_gb,
    'wallet_payment' as type,
    NULL as customer_email,
    NULL as store_name,
    NULL as shop_owner_id,
    NULL as shop_owner_email
FROM wallet_payments wp
WHERE wp.status = 'completed';
