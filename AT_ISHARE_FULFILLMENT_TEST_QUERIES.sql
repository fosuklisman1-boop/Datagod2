-- AT-iShare Order Fulfillment - SQL Testing Guide
-- Run these queries to verify the implementation

-- 1. Check if fulfillment_logs table exists and has data
SELECT COUNT(*) as fulfillment_count FROM fulfillment_logs;

-- 2. View all AT-iShare orders and their fulfillment status
SELECT 
  o.id,
  o.phone_number,
  o.size,
  o.fulfillment_status,
  fl.status as fulfillment_log_status,
  fl.attempt_number,
  fl.error_message,
  fl.created_at
FROM orders o
LEFT JOIN fulfillment_logs fl ON o.id = fl.order_id
WHERE o.network = 'AT-iShare'
ORDER BY o.created_at DESC
LIMIT 10;

-- 3. View failed fulfillments that can be retried
SELECT 
  o.id as order_id,
  o.phone_number,
  fl.attempt_number,
  fl.max_attempts,
  fl.error_message,
  fl.retry_after,
  NOW() as current_time
FROM orders o
JOIN fulfillment_logs fl ON o.id = fl.order_id
WHERE o.network = 'AT-iShare'
  AND fl.status = 'failed'
  AND fl.attempt_number < fl.max_attempts
ORDER BY fl.retry_after ASC;

-- 4. View fulfillment success rate
SELECT 
  COUNT(*) as total_orders,
  SUM(CASE WHEN fulfillment_status = 'success' THEN 1 ELSE 0 END) as successful,
  SUM(CASE WHEN fulfillment_status = 'failed' THEN 1 ELSE 0 END) as failed,
  SUM(CASE WHEN fulfillment_status = 'processing' THEN 1 ELSE 0 END) as processing,
  ROUND(
    100.0 * SUM(CASE WHEN fulfillment_status = 'success' THEN 1 ELSE 0 END) / 
    COUNT(*), 
    2
  ) as success_rate_percent
FROM orders
WHERE network = 'AT-iShare'
  AND created_at > NOW() - INTERVAL '7 days';

-- 5. View orders needing immediate retry
SELECT 
  o.id as order_id,
  o.phone_number,
  fl.status,
  fl.attempt_number,
  fl.retry_after,
  EXTRACT(EPOCH FROM (NOW() - fl.retry_after)) as seconds_past_retry_time
FROM orders o
JOIN fulfillment_logs fl ON o.id = fl.order_id
WHERE o.network = 'AT-iShare'
  AND fl.status = 'failed'
  AND fl.attempt_number < fl.max_attempts
  AND fl.retry_after <= NOW()
ORDER BY fl.retry_after ASC;

-- 6. Check fulfillment logs by status
SELECT 
  status,
  COUNT(*) as count,
  MAX(updated_at) as last_update
FROM fulfillment_logs
GROUP BY status
ORDER BY count DESC;

-- 7. View API response errors
SELECT 
  error_message,
  COUNT(*) as occurrence_count,
  MAX(updated_at) as last_occurrence
FROM fulfillment_logs
WHERE error_message IS NOT NULL
GROUP BY error_message
ORDER BY occurrence_count DESC;

-- 8. Check for stuck fulfillments (processing for too long)
SELECT 
  o.id as order_id,
  o.phone_number,
  fl.status,
  fl.created_at,
  NOW() - fl.created_at as duration
FROM orders o
JOIN fulfillment_logs fl ON o.id = fl.order_id
WHERE o.network = 'AT-iShare'
  AND fl.status = 'processing'
  AND NOW() - fl.created_at > INTERVAL '1 hour'
ORDER BY fl.created_at ASC;

-- 9. Export fulfillment statistics by date
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total_orders,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
  ROUND(
    100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / COUNT(*),
    2
  ) as success_rate_percent
FROM fulfillment_logs
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- 10. Find orders by phone number and check fulfillment
SELECT 
  o.id,
  o.phone_number,
  o.size,
  o.created_at,
  o.fulfillment_status,
  fl.status as log_status,
  fl.error_message
FROM orders o
LEFT JOIN fulfillment_logs fl ON o.id = fl.order_id
WHERE o.network = 'AT-iShare'
  AND o.phone_number LIKE '%PHONE_NUMBER%'
ORDER BY o.created_at DESC;
