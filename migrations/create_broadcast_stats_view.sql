-- Unique index for broadcast_logs to support joins if needed, already PK.

-- Create a view that aggregates stats from email_logs and sms_logs
CREATE OR REPLACE VIEW broadcast_stats_view AS
SELECT 
    b.id,
    b.admin_id,
    b.channels,
    b.target_type,
    b.target_group,
    b.subject,
    b.message,
    b.created_at,
    b.status,
    -- Store original results but override with dynamic counts if needed
    b.results as stored_results, 
    
    -- Dynamic Counts
    COALESCE(e.sent, 0) as email_sent_count,
    COALESCE(e.failed, 0) as email_failed_count,
    COALESCE(sb.sent, 0) as sms_sent_count,
    COALESCE(sb.failed, 0) as sms_failed_count,
    
    (COALESCE(e.sent, 0) + COALESCE(sb.sent, 0)) as total_sent,
    (COALESCE(e.failed, 0) + COALESCE(sb.failed, 0)) as total_failed

FROM broadcast_logs b
LEFT JOIN (
    SELECT reference_id, 
           COUNT(*) FILTER (WHERE status = 'sent') as sent,
           COUNT(*) FILTER (WHERE status = 'failed') as failed
    FROM email_logs
    GROUP BY reference_id
) e ON b.id::text = e.reference_id
LEFT JOIN (
    SELECT reference_id, 
           COUNT(*) FILTER (WHERE status = 'sent') as sent,
           COUNT(*) FILTER (WHERE status = 'failed') as failed
    FROM sms_logs
    GROUP BY reference_id
) sb ON b.id::text = sb.reference_id;

-- Grant access
GRANT SELECT ON broadcast_stats_view TO service_role;
GRANT SELECT ON broadcast_stats_view TO authenticated;
