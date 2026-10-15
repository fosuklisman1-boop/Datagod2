-- 0126_hubtel_ussd_interactions.sql
-- Transcript of every Hubtel USSD request and our reply (one row per exchange), so admins and
-- shop owners can read a session the way Hubtel's own dashboard shows it. Written after the reply
-- is sent (best-effort: a failed write never changes what the caller sees).
--
-- ADDITIVE and safe to apply before or after the deploy: until it is applied, writes are rejected
-- and dropped (one warning per process) and the viewers say the log is unavailable.
-- Retention: the hubtel-callbacks cron deletes rows older than 30 days.

CREATE TABLE IF NOT EXISTS hubtel_ussd_interactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  session_id    text NOT NULL,
  seq           int,
  mobile        text,
  platform      text,
  request_type  text,          -- Initiation | Response | Timeout
  input         text,          -- what the caller typed (the dial string on Initiation)
  reply_type    text,          -- response | release | AddToCart
  reply         text,          -- the screen we showed
  step          text,          -- our flow step after the reply (ClientState)
  mode          text,          -- main | shop
  shop_id       uuid           -- set once a shop code has been accepted in this session
);

CREATE INDEX IF NOT EXISTS idx_hubtel_ussd_interactions_session ON hubtel_ussd_interactions (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hubtel_ussd_interactions_shop ON hubtel_ussd_interactions (shop_id, created_at DESC) WHERE shop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hubtel_ussd_interactions_created_at ON hubtel_ussd_interactions (created_at DESC);

ALTER TABLE hubtel_ussd_interactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_ussd_interactions FROM anon, authenticated;

-- One summary row per session, newest first. multi_shop = more than one shop's code was accepted in
-- the session (the app then hides the payment from a shop owner: it may be the other shop's order).
-- p_shop_id limits to sessions where that shop's code was accepted; p_before pages by started_at.
-- The payment state comes from hubtel_transactions.
DROP FUNCTION IF EXISTS hubtel_ussd_session_summaries(uuid, timestamptz, int);
CREATE OR REPLACE FUNCTION hubtel_ussd_session_summaries(p_shop_id uuid, p_before timestamptz, p_limit int)
RETURNS TABLE(
  session_id text, mobile text, shop_id uuid, mode text, started_at timestamptz, ended_at timestamptz,
  exchanges int, last_reply_type text, last_request_type text, payment_state text, amount numeric, multi_shop boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH picked AS (
    SELECT i.session_id
    FROM hubtel_ussd_interactions i
    WHERE (p_shop_id IS NULL OR i.shop_id = p_shop_id)
    GROUP BY i.session_id
    HAVING p_before IS NULL OR min(i.created_at) < p_before
    ORDER BY min(i.created_at) DESC
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 100)
  ),
  s AS (
    SELECT i.session_id,
           max(i.mobile) AS mobile,
           (array_agg(i.shop_id ORDER BY i.created_at DESC) FILTER (WHERE i.shop_id IS NOT NULL))[1] AS shop_id,
           (array_agg(i.mode ORDER BY i.created_at) FILTER (WHERE i.mode IS NOT NULL))[1] AS mode,
           min(i.created_at) AS started_at,
           max(i.created_at) AS ended_at,
           count(*)::int AS exchanges,
           (array_agg(i.reply_type ORDER BY i.created_at DESC))[1] AS last_reply_type,
           (array_agg(i.request_type ORDER BY i.created_at DESC))[1] AS last_request_type,
           count(DISTINCT i.shop_id) > 1 AS multi_shop
    FROM hubtel_ussd_interactions i
    JOIN picked p ON p.session_id = i.session_id
    GROUP BY i.session_id
  )
  SELECT s.session_id, s.mobile, s.shop_id, s.mode, s.started_at, s.ended_at, s.exchanges,
         s.last_reply_type, s.last_request_type, t.state, t.expected_amount, s.multi_shop
  FROM s
  LEFT JOIN hubtel_transactions t ON t.session_id = s.session_id
  ORDER BY s.started_at DESC;
$$;

REVOKE ALL ON FUNCTION hubtel_ussd_session_summaries(uuid, timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hubtel_ussd_session_summaries(uuid, timestamptz, int) TO service_role;
