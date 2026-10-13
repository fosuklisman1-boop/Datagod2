-- Sender ID health, part 2: the PLATFORM's own sender names (OTP, order confirmations, top-up
-- notices, broadcasts — everything sendSMS() logs to sms_logs).
--
-- 1. sms_logs.sender_id: the "From" used for a Hubtel send (upper-cased), written by
--    lib/sms-service.ts sendSMSViaHubtel. Nullable, no default → metadata-only on ~137k rows.
--    Older rows stay NULL (no sender was recorded before this shipped). The app tolerates the
--    column being absent (retries the insert without it), so deploy order does not matter.
--    No index: the panel's window scan over ~137k rows is cheap; revisit if sms_logs grows a lot.
--
-- 2. sms_sender_health(p_hours): the applied 20261023 body (now the 'campaign' rows, unchanged
--    apart from the new "source" key) UNION the platform rows from sms_logs:
--      provider = 'hubtel' AND sender_id IS NOT NULL
--      AND message_type IS DISTINCT FROM 'shop_sms'   -- the drain's sends are counted via sms_messages
--      AND moolre_message_id IS NOT NULL              -- Hubtel accepted it (the DLR poller can resolve it);
--                                                     -- excludes pre-send rejections and "unknown" outcomes
--      created_at is TIMESTAMP WITHOUT TIME ZONE holding UTC wall clock → compared with
--      (now() AT TIME ZONE 'UTC') and converted back with AT TIME ZONE 'UTC' for output.
--    Status mapping: 'delivered' → delivered, 'failed' → failed, 'sent' → in_flight.
--    Platform rows: registry_status NULL, is_pool/kyc_free false, accounts 0. A name can appear
--    twice (once per source). Overall LIMIT 100 by total desc.
--
-- Read-only function, SECURITY DEFINER, service_role only. NOT applied automatically.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS sender_id TEXT;

CREATE OR REPLACE FUNCTION sms_sender_health(p_hours int)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH campaign_agg AS (
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
  ),
  campaign AS (
    SELECT a.sender, 'campaign'::text AS source, a.total, a.delivered, a.failed, a.in_flight,
           a.last_delivered_at, a.last_sent_at, a.accounts,
           reg.local_status                  AS registry_status,
           COALESCE(reg.is_pool, false)      AS is_pool,
           COALESCE(reg.kyc_free, false)     AS kyc_free
      FROM campaign_agg a
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
      ) reg ON NOT a.is_default
  ),
  platform AS (
    SELECT l.sender_id                                         AS sender,
           'platform'::text                                    AS source,
           count(*)                                            AS total,
           count(*) FILTER (WHERE l.status = 'delivered')      AS delivered,
           count(*) FILTER (WHERE l.status = 'failed')         AS failed,
           count(*) FILTER (WHERE l.status = 'sent')           AS in_flight,
           max(l.delivered_at) AT TIME ZONE 'UTC'              AS last_delivered_at,
           max(l.created_at) AT TIME ZONE 'UTC'                AS last_sent_at,
           0::bigint                                           AS accounts,
           NULL::text                                          AS registry_status,
           false                                               AS is_pool,
           false                                               AS kyc_free
      FROM sms_logs l
     WHERE l.provider = 'hubtel'
       AND l.sender_id IS NOT NULL
       AND l.message_type IS DISTINCT FROM 'shop_sms'
       AND l.moolre_message_id IS NOT NULL
       AND l.created_at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => GREATEST(LEAST(COALESCE(p_hours, 24), 720), 1))
     GROUP BY l.sender_id
  ),
  combined AS (
    SELECT * FROM campaign
    UNION ALL
    SELECT * FROM platform
    ORDER BY total DESC, sender, source
    LIMIT 100
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sender',            a.sender,
           'source',            a.source,
           'total',             a.total,
           'delivered',         a.delivered,
           'failed',            a.failed,
           'in_flight',         a.in_flight,
           'delivery_rate',     round(a.delivered::numeric / NULLIF(a.delivered + a.failed, 0), 4),
           'last_delivered_at', a.last_delivered_at,
           'last_sent_at',      a.last_sent_at,
           'accounts',          a.accounts,
           'registry_status',   a.registry_status,
           'is_pool',           a.is_pool,
           'kyc_free',          a.kyc_free
         ) ORDER BY a.total DESC, a.sender, a.source), '[]'::jsonb)
    FROM combined a;
$$;

REVOKE ALL ON FUNCTION sms_sender_health(int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_sender_health(int) TO service_role;

COMMIT;
