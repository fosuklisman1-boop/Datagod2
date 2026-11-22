-- 0191_bulk_send_guard.sql
--
-- Admin order work queue, bulk send to a chosen supplier. NOT applied by the implementing agent. One transaction. Idempotent.
--
--   1. fulfillment_queue_one_live_per_order: at most ONE live (pending/processing) queue row per order_id, so two admins
--      (or a double click) cannot send the same order twice. Completed/failed history rows are unaffected.
--      Enqueue code uses INSERT ... ON CONFLICT (order_id) WHERE status IN ('pending','processing') DO NOTHING.
--   2. admin_bulk_send_log: audit trail of each bulk send (who, which supplier, accepted/rejected/risky ids).
--      Service-role only: RLS on with no policies, everything revoked from PUBLIC/anon/authenticated.
--
-- claim_fulfillment_queue is untouched. Plain CREATE UNIQUE INDEX (not CONCURRENTLY: it cannot run inside a transaction); the
-- table is small (~15k rows) so the build fits well inside the 5s lock timeout.
--
-- PRE-CHECK (must return no rows, or the index build fails):
--   SELECT order_id, count(*) FROM fulfillment_queue WHERE status IN ('pending','processing') GROUP BY 1 HAVING count(*) > 1;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_queue_one_live_per_order
  ON fulfillment_queue (order_id) WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS admin_bulk_send_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     uuid        NOT NULL,
  supplier     text        NOT NULL,
  batch_id     uuid,
  accepted_ids text[]      NOT NULL,
  rejected     jsonb       NOT NULL DEFAULT '[]',
  risky_ids    text[]      NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_bulk_send_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_bulk_send_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON admin_bulk_send_log TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'fulfillment_queue_one_live_per_order';
--   SELECT has_table_privilege('anon', 'public.admin_bulk_send_log', 'SELECT'),
--          has_table_privilege('authenticated', 'public.admin_bulk_send_log', 'INSERT'),
--          has_table_privilege('service_role', 'public.admin_bulk_send_log', 'INSERT');   -- false, false, true
