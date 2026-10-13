-- Sender ID health for the admin SMS health page (/admin/sms-health → "Sender ID health").
--
-- sms_sender_health(p_hours): one row per sender NAME over Hubtel sends in the last p_hours, so
-- an admin can spot names that Hubtel accepts but a carrier silently drops (e.g. LINKSTOREGH:
-- 47 delivered / 35 Expired / 13 Undeliverable / 5 in flight in one batch).
--
-- Only Hubtel reports delivery (sms_messages.delivery_status pending → delivered/failed via the
-- DLR cron; Expired/Undeliverable/Rejected all map to failed). Moolre rows never get a DLR, so
-- they are excluded. The WHERE clause matches the partial index idx_sms_messages_hubtel_sent
-- (provider = 'hubtel' AND status = 'sent', on processed_at) so the window scan can use it.
--
-- Registry status: if any sms_sender_ids row with that name is 'active' → 'active', else the most
-- recently updated row's local_status; NULL when the name is not registered (incl. the
-- "(platform default)" bucket for sender_id IS NULL). is_pool / kyc_free = bool_or across rows.
--
-- Read-only, SECURITY DEFINER, service_role only. NOT applied automatically.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION sms_sender_health(p_hours int)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH agg AS (
    SELECT COALESCE(m.sender_id, '(platform default)')                AS sender,
           (m.sender_id IS NULL)                                      AS is_default,
           count(*)                                                   AS total,
           count(*) FILTER (WHERE m.delivery_status = 'delivered')    AS delivered,
           count(*) FILTER (WHERE m.delivery_status = 'failed')       AS failed,
           count(*) FILTER (WHERE m.delivery_status = 'pending')      AS in_flight,
           max(m.delivered_at)                                        AS last_delivered_at,
           max(m.processed_at)                                        AS last_sent_at,
           count(DISTINCT m.sms_account_id)                           AS accounts
      FROM sms_messages m
     WHERE m.provider = 'hubtel'
       AND m.status = 'sent'
       AND m.processed_at >= now() - make_interval(hours => GREATEST(LEAST(COALESCE(p_hours, 24), 720), 1))
     GROUP BY COALESCE(m.sender_id, '(platform default)'), (m.sender_id IS NULL)
     ORDER BY count(*) DESC
     LIMIT 100
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sender',            a.sender,
           'total',             a.total,
           'delivered',         a.delivered,
           'failed',            a.failed,
           'in_flight',         a.in_flight,
           'delivery_rate',     round(a.delivered::numeric / NULLIF(a.delivered + a.failed, 0), 4),
           'last_delivered_at', a.last_delivered_at,
           'last_sent_at',      a.last_sent_at,
           'accounts',          a.accounts,
           'registry_status',   reg.local_status,
           'is_pool',           COALESCE(reg.is_pool, false),
           'kyc_free',          COALESCE(reg.kyc_free, false)
         ) ORDER BY a.total DESC, a.sender), '[]'::jsonb)
    FROM agg a
    LEFT JOIN LATERAL (
      SELECT (SELECT s.local_status
                FROM sms_sender_ids s
               WHERE s.sender_id = a.sender
               ORDER BY (s.local_status = 'active') DESC, s.updated_at DESC
               LIMIT 1)                                   AS local_status,
             bool_or(s.is_pool)                           AS is_pool,
             bool_or(s.kyc_free)                          AS kyc_free
        FROM sms_sender_ids s
       WHERE s.sender_id = a.sender
    ) reg ON NOT a.is_default;
$$;

REVOKE ALL ON FUNCTION sms_sender_health(int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_sender_health(int) TO service_role;

COMMIT;
