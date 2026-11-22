-- Auto-fulfil pending orders: schema, candidate finder, split queue claim. NOT applied by the implementing agent. One transaction. Idempotent.
--
--   1. fulfillment_queue.source ('admin' | 'auto'): existing rows become 'admin' (the column default), so nothing already queued changes.
--   2. auto_fulfil_runs / auto_fulfil_attempts / auto_fulfil_settings_log: run history, per-send outcomes, settings audit.
--      Service-role only: RLS on with no policies, everything revoked from PUBLIC/anon/authenticated. No phone or message columns.
--   3. auto_fulfil_candidates(...): paid, still-pending orders in the allowed networks, old enough, with NO queue / tracking / log
--      activity inside the quiet window (= p_min_age_minutes). Read-only. combined_orders_view already exposes only paid
--      shop/USSD rows (their WHERE payment_status = 'completed'; bulk/api rows are constant 'completed'); the function repeats
--      that filter anyway, so a future view change cannot leak unpaid rows.
--      Timestamp columns on tracking / fulfillment_logs are "timestamp without time zone" written by NOW() in a UTC session, so the
--      function pins timezone = 'UTC' to make the comparison independent of the caller's session zone.
--   4. claim_fulfillment_queue_split(p_limit, p_auto_limit): same claim semantics as claim_fulfillment_queue, but at most
--      p_auto_limit 'auto' rows. Admin rows have priority (up to p_limit); auto rows fill only the remaining capacity.
--      Plain SQL on purpose (no bare END statement, so the dry-run string builder's COMMIT/END guard stays meaningful).
--
-- claim_fulfillment_queue is untouched. The table is small (~15k rows); the CHECK on the new column validates inside the 5s lock timeout.
--
-- PRE-CHECK (read-only; both must return no rows, or 0193 was already partly applied by hand with a different shape):
--   SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'fulfillment_queue' AND column_name = 'source';
--   SELECT proname FROM pg_proc WHERE proname IN ('auto_fulfil_candidates', 'claim_fulfillment_queue_split');
-- PRE-CHECK for the selftest seed (read-only): orders NOT NULL columns without a default must all be in the selftest's orders INSERT
-- (id, user_id, network, size, price, status, phone_number, created_at); see 0193_auto_fulfil.selftest.sql header.
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'orders' AND is_nullable = 'NO' AND column_default IS NULL ORDER BY ordinal_position;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE fulfillment_queue
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'auto'));

CREATE TABLE IF NOT EXISTS auto_fulfil_runs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  queued       int         NOT NULL DEFAULT 0,
  waiting      int         NOT NULL DEFAULT 0,
  needs_you    int         NOT NULL DEFAULT 0,
  skipped      jsonb       NOT NULL DEFAULT '{}',
  summary_sent boolean     NOT NULL DEFAULT false,
  error        text
);

CREATE TABLE IF NOT EXISTS auto_fulfil_attempts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid        NOT NULL REFERENCES auto_fulfil_runs(id),
  queue_id    uuid        NOT NULL,
  order_id    text        NOT NULL,
  order_type  text        NOT NULL,
  outcome     text        CHECK (outcome IN ('sent', 'rate_limited', 'out_of_balance', 'supplier_unavailable', 'not_enabled',
                                             'no_bundle', 'wrong_number', 'rejected', 'unclassified', 'held', 'skipped')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS auto_fulfil_attempts_order_created ON auto_fulfil_attempts (order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auto_fulfil_settings_log (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid        NOT NULL,
  old_value  jsonb,
  new_value  jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auto_fulfil_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_fulfil_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_fulfil_settings_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON auto_fulfil_runs, auto_fulfil_attempts, auto_fulfil_settings_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON auto_fulfil_runs TO service_role;
GRANT SELECT, INSERT, UPDATE ON auto_fulfil_attempts TO service_role;
GRANT SELECT, INSERT ON auto_fulfil_settings_log TO service_role;

-- Paged (p_offset) so parked orders cannot hold every slot. The quiet-window checks are materialised CTEs of the few recently
-- active ids (one scan each) joined with a hash anti-join, instead of three correlated NOT EXISTS per order (that form exceeded
-- the timeout at a 6,000-row backlog). A send updates its tracking row in place, so tracking counts created_at OR updated_at.
-- NULL link columns produce NULL ids, which never equal an order id.
CREATE OR REPLACE FUNCTION auto_fulfil_candidates(p_min_age_minutes int, p_max_age_days int, p_networks text[], p_scan int, p_offset int DEFAULT 0)
RETURNS TABLE (id text, type text, network text, phone_number text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET statement_timeout = '20s'
SET timezone = 'UTC'
AS $$
  WITH recent_queue AS MATERIALIZED (
    SELECT q.order_id::text AS order_id
    FROM fulfillment_queue q
    WHERE q.enqueued_at > now() - make_interval(mins => p_min_age_minutes)
       OR q.last_attempted_at > now() - make_interval(mins => p_min_age_minutes)
       OR q.completed_at > now() - make_interval(mins => p_min_age_minutes)
  ), recent_tracking AS MATERIALIZED (
    SELECT t.order_id::text AS order_id, t.shop_order_id::text AS shop_order_id, t.api_order_id::text AS api_order_id
    FROM mtn_fulfillment_tracking t
    WHERE t.created_at > now() - make_interval(mins => p_min_age_minutes)
       OR t.updated_at > now() - make_interval(mins => p_min_age_minutes)
  ), recent_logs AS MATERIALIZED (
    SELECT l.order_id::text AS order_id, l.api_order_id::text AS api_order_id
    FROM fulfillment_logs l
    WHERE l.updated_at > now() - make_interval(mins => p_min_age_minutes)
  ), busy AS MATERIALIZED (
    SELECT order_id AS id FROM recent_queue
    UNION SELECT order_id FROM recent_tracking
    UNION SELECT shop_order_id FROM recent_tracking
    UNION SELECT api_order_id FROM recent_tracking
    UNION SELECT order_id FROM recent_logs
    UNION SELECT api_order_id FROM recent_logs
  )
  SELECT v.id::text, v.type::text, v.network::text, v.phone_number::text, v.created_at::timestamptz
  FROM combined_orders_view v
  WHERE v.status = 'pending'
    AND v.payment_status = 'completed'
    AND v.created_at >= now() - make_interval(days => p_max_age_days)
    AND v.created_at <= now() - make_interval(mins => p_min_age_minutes)
    AND v.network = ANY (p_networks)
    AND NOT EXISTS (SELECT 1 FROM busy WHERE busy.id = v.id::text)
  ORDER BY v.created_at ASC, v.id ASC
  LIMIT GREATEST(COALESCE(p_scan, 0), 0)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
$$;

CREATE OR REPLACE FUNCTION claim_fulfillment_queue_split(p_limit int, p_auto_limit int)
RETURNS SETOF fulfillment_queue
LANGUAGE sql
AS $$
  WITH admin_rows AS (
    SELECT id FROM fulfillment_queue
    WHERE status = 'pending' AND source = 'admin'
    ORDER BY enqueued_at ASC
    LIMIT GREATEST(COALESCE(p_limit, 0), 0)
    FOR UPDATE SKIP LOCKED
  ), auto_rows AS (
    SELECT id FROM fulfillment_queue
    WHERE status = 'pending' AND source = 'auto'
    ORDER BY enqueued_at ASC
    LIMIT GREATEST(LEAST(COALESCE(p_auto_limit, 0), GREATEST(COALESCE(p_limit, 0), 0) - (SELECT count(*) FROM admin_rows)), 0)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE fulfillment_queue
  SET status = 'processing',
      attempt_count = attempt_count + 1,
      last_attempted_at = NOW()
  WHERE id IN (SELECT id FROM admin_rows UNION ALL SELECT id FROM auto_rows)
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION auto_fulfil_candidates(int, int, text[], int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION auto_fulfil_candidates(int, int, text[], int, int) TO service_role;
REVOKE ALL ON FUNCTION claim_fulfillment_queue_split(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_fulfillment_queue_split(int, int) TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'fulfillment_queue' AND column_name = 'source';  -- 'admin'::text, NO
--   SELECT source, count(*) FROM fulfillment_queue GROUP BY 1;                                                                             -- all 'admin'
--   SELECT has_table_privilege('anon', 'public.auto_fulfil_runs', 'SELECT'), has_table_privilege('authenticated', 'public.auto_fulfil_attempts', 'SELECT'),
--          has_function_privilege('authenticated', 'public.auto_fulfil_candidates(int,int,text[],int,int)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.auto_fulfil_candidates(int,int,text[],int,int)', 'EXECUTE');                       -- false, false, false, true
--   SELECT has_function_privilege('anon', 'public.claim_fulfillment_queue_split(int,int)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.claim_fulfillment_queue_split(int,int)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.claim_fulfillment_queue_split(int,int)', 'EXECUTE');                             -- false, false, true
