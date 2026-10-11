-- SMS admin console (Phase 2): exact overview numbers + searchable, paged lists.
BEGIN;

CREATE OR REPLACE FUNCTION sms_admin_overview()
RETURNS TABLE(
  revenue_bundles_ghs NUMERIC, revenue_activations_ghs NUMERIC,
  credits_sold BIGINT, purchases BIGINT,
  unrecorded_purchases BIGINT, unrecorded_credits BIGINT,
  pending_reviews BIGINT, pending_senders BIGINT,
  fraud_flags BIGINT, info_flags BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH b AS (
    SELECT COALESCE(sum(amount_ghs), 0)                                           AS rev,
           COALESCE(sum(delta), 0)::bigint                                        AS credits,
           count(*)::bigint                                                       AS n,
           count(*) FILTER (WHERE amount_ghs IS NULL)::bigint                     AS unrec_n,
           COALESCE(sum(delta) FILTER (WHERE amount_ghs IS NULL), 0)::bigint      AS unrec_credits
    FROM sms_unit_transactions
    WHERE reason IN ('bundle_wallet', 'bundle_paystack') AND delta > 0
  )
  SELECT
    b.rev,
    (SELECT COALESCE(sum(amount_paid), 0) FROM sms_accounts WHERE amount_paid > 0),
    b.credits, b.n, b.unrec_n, b.unrec_credits,
    (SELECT count(*) FROM sms_business_profiles WHERE status = 'submitted'),
    (SELECT count(*) FROM sms_sender_ids WHERE local_status = 'pending' AND sms_account_id IS NOT NULL),
    (SELECT count(*) FROM sms_flags WHERE severity = 'fraud' AND status = 'open')
      + (SELECT count(*) FROM sms_send_logs WHERE flagged AND status = 'blocked'),
    (SELECT count(*) FROM sms_flags WHERE severity = 'info' AND status = 'open')
      + (SELECT count(*) FROM sms_send_logs WHERE flagged AND status <> 'blocked')
  FROM b;
$$;

-- What the new (record-only) policy WOULD have done recently, from sms_send_logs.policy_shadow.
CREATE OR REPLACE FUNCTION sms_policy_preview(p_days INT DEFAULT 7)
RETURNS TABLE(decision TEXT, code TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(policy_shadow->>'decision', 'error'),
         COALESCE(policy_shadow->>'code', 'ERROR'),
         count(*)::bigint
  FROM sms_send_logs
  WHERE policy_shadow IS NOT NULL
    AND created_at >= now() - make_interval(days => GREATEST(p_days, 1))
  GROUP BY 1, 2
  ORDER BY 3 DESC;
$$;

CREATE OR REPLACE FUNCTION sms_admin_messages(p_q TEXT, p_status TEXT, p_limit INT, p_offset INT)
RETURNS TABLE(
  id BIGINT, sms_account_id UUID, user_id UUID, mode TEXT, sender_id TEXT, status TEXT,
  recipients_count INT, segments INT, credits_used INT, message TEXT, created_at TIMESTAMPTZ,
  tracked BIGINT, delivered BIGINT, failed BIGINT, pending BIGINT, total_count BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH page AS (
    SELECT l.id, l.sms_account_id, a.user_id, COALESCE(l.mode, a.mode) AS mode, l.sender_id, l.status,
           l.recipients_count, l.segments, l.credits_used, l.message, l.created_at,
           count(*) OVER () AS total_count
    FROM sms_send_logs l
    JOIN sms_accounts a ON a.id = l.sms_account_id
    WHERE (p_status IS NULL OR p_status = '' OR l.status = p_status)
      AND (p_q IS NULL OR p_q = ''
           OR strpos(lower(l.message), lower(p_q)) > 0
           OR strpos(lower(COALESCE(l.sender_id, '')), lower(p_q)) > 0
           OR strpos(lower(l.status), lower(p_q)) > 0
           OR (CASE WHEN p_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN a.user_id = p_q::uuid ELSE false END))
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0)
  )
  SELECT p.id, p.sms_account_id, p.user_id, p.mode, p.sender_id, p.status,
         p.recipients_count, p.segments, p.credits_used, p.message, p.created_at,
         COALESCE(d.tracked, 0), COALESCE(d.delivered, 0), COALESCE(d.failed, 0), COALESCE(d.pending, 0),
         p.total_count
  FROM page p
  LEFT JOIN LATERAL (
    -- Only Hubtel messages carry delivery reports; Moolre rows stay 'pending' forever, so don't count them.
    SELECT count(*) AS tracked,
           count(*) FILTER (WHERE m.delivery_status = 'delivered') AS delivered,
           count(*) FILTER (WHERE m.delivery_status = 'failed')    AS failed,
           count(*) FILTER (WHERE m.delivery_status = 'pending')   AS pending
    FROM sms_messages m
    WHERE m.send_log_id = p.id AND m.provider = 'hubtel'
  ) d ON true
  ORDER BY p.created_at DESC, p.id DESC;
$$;

CREATE OR REPLACE FUNCTION sms_admin_accounts(p_q TEXT, p_limit INT, p_offset INT)
RETURNS TABLE(
  id UUID, user_id UUID, email TEXT, owner_type TEXT, mode TEXT, status TEXT, unit_balance INT,
  bought BIGINT, used BIGINT, default_sender TEXT, api_rate_limit_override INT, review_hold BOOLEAN,
  fraud_flag_count INT, created_at TIMESTAMPTZ, total_count BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH page AS (
    SELECT a.id, a.user_id, u.email, a.owner_type, a.mode, a.status, a.unit_balance,
           a.default_sender_id, a.api_rate_limit_override, a.review_hold, a.fraud_flag_count, a.created_at,
           count(*) OVER () AS total_count
    FROM sms_accounts a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE p_q IS NULL OR p_q = ''
       OR strpos(lower(COALESCE(u.email, '')), lower(p_q)) > 0
       OR strpos(lower(a.mode), lower(p_q)) > 0
       OR strpos(lower(a.status), lower(p_q)) > 0
       OR strpos(lower(a.owner_type), lower(p_q)) > 0
       OR (CASE WHEN p_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN a.user_id = p_q::uuid ELSE false END)
       OR EXISTS (SELECT 1 FROM sms_sender_ids s
                  WHERE s.sms_account_id = a.id AND strpos(lower(s.sender_id), lower(p_q)) > 0)
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0)
  )
  SELECT p.id, p.user_id, p.email, p.owner_type, p.mode, p.status, p.unit_balance,
         (SELECT COALESCE(sum(t.delta), 0) FROM sms_unit_transactions t
           WHERE t.sms_account_id = p.id AND t.delta > 0 AND t.reason IN ('bundle_wallet','bundle_paystack'))::bigint,
         (SELECT COALESCE(sum(l.credits_used), 0) FROM sms_send_logs l
           WHERE l.sms_account_id = p.id AND l.status <> 'blocked')::bigint,
         (SELECT s.sender_id FROM sms_sender_ids s WHERE s.id = p.default_sender_id),
         p.api_rate_limit_override, p.review_hold, p.fraud_flag_count, p.created_at, p.total_count
  FROM page p
  ORDER BY p.created_at DESC, p.id DESC;
$$;

CREATE OR REPLACE FUNCTION sms_admin_flags(p_severity TEXT, p_status TEXT, p_limit INT, p_offset INT)
RETURNS TABLE(
  id TEXT, source TEXT, sms_account_id UUID, user_id UUID, severity TEXT, reason TEXT, matched TEXT,
  status TEXT, message TEXT, created_at TIMESTAMPTZ, total_count BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH merged AS (
    SELECT f.id::text AS id, 'flag'::text AS source, f.sms_account_id, f.severity, f.reason, f.matched,
           f.status, l.message, f.created_at
    FROM sms_flags f
    LEFT JOIN sms_send_logs l ON l.id = f.send_log_id
    UNION ALL
    -- Legacy content-filter flags live on the send log itself (dismissing clears the flag).
    SELECT l.id::text, 'legacy', l.sms_account_id,
           CASE WHEN l.status = 'blocked' THEN 'fraud' ELSE 'info' END,
           COALESCE(l.flag_reason, 'flagged'), NULL::text, 'open', l.message, l.created_at
    FROM sms_send_logs l
    WHERE l.flagged
  ), filtered AS (
    SELECT m.*, a.user_id, count(*) OVER () AS total_count
    FROM merged m
    JOIN sms_accounts a ON a.id = m.sms_account_id
    WHERE (p_severity IS NULL OR p_severity = '' OR m.severity = p_severity)
      AND (p_status IS NULL OR p_status = '' OR m.status = p_status)
    ORDER BY m.created_at DESC, m.source, m.id
    LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0)
  )
  SELECT f.id, f.source, f.sms_account_id, f.user_id, f.severity, f.reason, f.matched, f.status,
         f.message, f.created_at, f.total_count
  FROM filtered f
  ORDER BY f.created_at DESC, f.source, f.id;
$$;

REVOKE ALL ON FUNCTION sms_admin_overview()                            FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_admin_overview()                        TO service_role;
REVOKE ALL ON FUNCTION sms_policy_preview(INT)                         FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_policy_preview(INT)                     TO service_role;
REVOKE ALL ON FUNCTION sms_admin_messages(TEXT, TEXT, INT, INT)        FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_admin_messages(TEXT, TEXT, INT, INT)    TO service_role;
REVOKE ALL ON FUNCTION sms_admin_accounts(TEXT, INT, INT)              FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_admin_accounts(TEXT, INT, INT)          TO service_role;
REVOKE ALL ON FUNCTION sms_admin_flags(TEXT, TEXT, INT, INT)           FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_admin_flags(TEXT, TEXT, INT, INT)       TO service_role;

COMMIT;
