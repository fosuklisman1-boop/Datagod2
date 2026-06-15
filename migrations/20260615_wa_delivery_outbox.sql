-- WhatsApp "your data has been delivered" confirmation — capture + outbox.
--
-- WHY A TRIGGER (not call sites): an order reaches status='completed' from ~16
-- different code paths across 5 retail order tables — TWO manual-admin endpoints
-- (bulk-update-status, shop-orders/update-status) + airtime admin action, all the
-- provider webhooks (MTN Sykes/Datakazina/Xpress, digiwapy), the reconciliation
-- crons (sync-mtn-status x2, sync-codecraft, sync-digiwapy), and AT-iShare
-- auto-fulfillment. There is NO shared status-update chokepoint. Editing each site
-- would silently miss the others (and any future one). An AFTER UPDATE trigger
-- captures every writer — manual, webhook, cron, future — in one place.
--
-- SAFETY: the trigger is INSERT-only, wrapped EXCEPTION WHEN OTHERS THEN RETURN
-- NEW, so it can NEVER slow, throw into, or roll back the order UPDATE. The
-- send itself happens fully out-of-band (a cron drains this outbox). Idempotency
-- is enforced by Postgres (UNIQUE(order_table, order_id) + ON CONFLICT DO
-- NOTHING): a webhook + a cron re-confirming the same 'completed' can enqueue at
-- most one notification per order. api_orders is intentionally EXCLUDED — those
-- are B2B/programmatic reseller orders, not retail customers awaiting a receipt.
--
-- Installing the triggers does NOT fire on the ~145k existing completed rows
-- (triggers fire only on new UPDATE transitions). The WHEN clause also gates on
-- created_at within 3 days so an admin back-filling OLD orders to 'completed'
-- doesn't blast stale "delivered" messages.

BEGIN;

-- ---------------------------------------------------------------------------
-- Outbox: one row per order whose status transitioned to 'completed'.
-- status lifecycle: pending -> processing -> sent | skipped_cold | skipped | failed
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wa_delivery_outbox (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_table TEXT NOT NULL,
  order_id    UUID NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INT  NOT NULL DEFAULT 0,
  last_error  TEXT,
  claimed_at  TIMESTAMPTZ,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_wa_delivery_outbox UNIQUE (order_table, order_id)
);

-- Hot "what's left to send" lookup stays tiny as sent rows pile up.
CREATE INDEX IF NOT EXISTS idx_wa_delivery_outbox_drain
  ON wa_delivery_outbox(created_at)
  WHERE status IN ('pending', 'failed');

ALTER TABLE wa_delivery_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on wa_delivery_outbox" ON wa_delivery_outbox;
CREATE POLICY "Service role full access on wa_delivery_outbox"
  ON wa_delivery_outbox FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Direct anon/authenticated access is never needed (all reads/writes are
-- service-role server paths); deny it explicitly on top of RLS default-deny.
REVOKE ALL ON TABLE wa_delivery_outbox FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Capture trigger function. Generic across tables: the per-table status column
-- name + freshness gate live in each trigger's WHEN clause (where the column
-- type is known), so the function body just does the idempotent enqueue.
-- SECURITY DEFINER so the insert succeeds regardless of the writer's role; the
-- body is static (no dynamic SQL) and search_path is pinned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_wa_delivery()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO wa_delivery_outbox(order_table, order_id)
  VALUES (TG_TABLE_NAME, NEW.id)
  ON CONFLICT (order_table, order_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Best-effort: a notification-capture failure must never break fulfillment.
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enqueue_wa_delivery() FROM PUBLIC, anon, authenticated;

-- Triggers, one per retail order table. WHEN fires ONLY on a genuine transition
-- INTO 'completed' for a recently-created order — so it skips no-op re-saves and
-- back-fills of old orders, and the function isn't even called otherwise.
DROP TRIGGER IF EXISTS trg_wa_delivery ON orders;
CREATE TRIGGER trg_wa_delivery AFTER UPDATE ON orders FOR EACH ROW
WHEN (NEW.status = 'completed' AND NEW.status IS DISTINCT FROM OLD.status
      AND NEW.created_at > now() - interval '3 days')
EXECUTE FUNCTION enqueue_wa_delivery();

DROP TRIGGER IF EXISTS trg_wa_delivery ON shop_orders;
CREATE TRIGGER trg_wa_delivery AFTER UPDATE ON shop_orders FOR EACH ROW
WHEN (NEW.order_status = 'completed' AND NEW.order_status IS DISTINCT FROM OLD.order_status
      AND NEW.created_at > now() - interval '3 days')
EXECUTE FUNCTION enqueue_wa_delivery();

DROP TRIGGER IF EXISTS trg_wa_delivery ON ussd_orders;
CREATE TRIGGER trg_wa_delivery AFTER UPDATE ON ussd_orders FOR EACH ROW
WHEN (NEW.order_status = 'completed' AND NEW.order_status IS DISTINCT FROM OLD.order_status
      AND NEW.created_at > now() - interval '3 days')
EXECUTE FUNCTION enqueue_wa_delivery();

DROP TRIGGER IF EXISTS trg_wa_delivery ON ussd_shop_orders;
CREATE TRIGGER trg_wa_delivery AFTER UPDATE ON ussd_shop_orders FOR EACH ROW
WHEN (NEW.order_status = 'completed' AND NEW.order_status IS DISTINCT FROM OLD.order_status
      AND NEW.created_at > now() - interval '3 days')
EXECUTE FUNCTION enqueue_wa_delivery();

DROP TRIGGER IF EXISTS trg_wa_delivery ON airtime_orders;
CREATE TRIGGER trg_wa_delivery AFTER UPDATE ON airtime_orders FOR EACH ROW
WHEN (NEW.status = 'completed' AND NEW.status IS DISTINCT FROM OLD.status
      AND NEW.created_at > now() - interval '3 days')
EXECUTE FUNCTION enqueue_wa_delivery();

-- ---------------------------------------------------------------------------
-- claim_wa_delivery: atomically grab the next batch to send (mirrors
-- claim_broadcast_recipients). FOR UPDATE SKIP LOCKED so concurrent cron
-- instances never grab the same row. Retries terminate at max_attempts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_wa_delivery(lim INT, max_attempts INT DEFAULT 3)
RETURNS SETOF wa_delivery_outbox
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE wa_delivery_outbox o
  SET status = 'processing',
      attempts = o.attempts + 1,
      claimed_at = now()
  WHERE o.id IN (
    SELECT id FROM wa_delivery_outbox
    WHERE (status = 'pending' OR (status = 'failed' AND attempts < max_attempts))
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT lim
  )
  RETURNING o.*;
END;
$$;

-- Privileged RPC: service-role only (mirrors 20260615_lock_privileged_rpcs).
REVOKE ALL ON FUNCTION claim_wa_delivery(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_wa_delivery(INT, INT) TO service_role;

COMMIT;
