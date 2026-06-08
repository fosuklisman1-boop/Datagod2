-- One-time reconciliation of stale fulfillment bookkeeping rows.
--
-- Going forward, admin completion paths + the self-healing crons keep these in
-- sync. This migration clears the EXISTING backlog: tracking/log rows still in a
-- non-terminal state even though their underlying order is already terminal
-- (completed / cancelled / refunded), which made the status-sync crons keep
-- re-querying the provider for them.
--
-- Safe + idempotent: the WHERE clauses exclude already-terminal rows, so re-running
-- is a no-op. "pending" orders are intentionally NOT reconciled — a provider
-- "failed" maps the order back to pending so it stays re-fulfillable.
--
-- NOTE: mtn_fulfillment_tracking.order_id is varchar while orders.id (etc.) are
-- uuid, so every comparison casts both sides to text. IDs are unique per table,
-- so matching order_id against multiple order tables via OR cannot mis-match.

-- ── 1. MTN tracking (drives app/api/cron/sync-mtn-status) ─────────────────────
UPDATE mtn_fulfillment_tracking AS t
SET status = 'completed',
    updated_at = NOW()
WHERE t.status IN ('pending', 'processing', 'failed', 'retrying', 'error')
  AND (
    t.shop_order_id::text IN (SELECT id::text FROM shop_orders      WHERE order_status IN ('completed','cancelled','refunded'))
    OR t.api_order_id::text IN (SELECT id::text FROM api_orders      WHERE status        IN ('completed','cancelled','refunded'))
    OR t.order_id::text     IN (SELECT id::text FROM orders          WHERE status        IN ('completed','cancelled','refunded'))
    OR t.order_id::text     IN (SELECT id::text FROM ussd_orders     WHERE order_status  IN ('completed','cancelled','refunded'))
    OR t.order_id::text     IN (SELECT id::text FROM ussd_shop_orders WHERE order_status IN ('completed','cancelled','refunded'))
  );

-- ── 2. fulfillment_logs (drives the AT/CodeCraft checkScheduledOrders retry loop) ──
-- order_id is polymorphic (shop / bulk / ussd order id); api_orders also via api_order_id.
UPDATE fulfillment_logs AS f
SET status = 'success',
    updated_at = NOW()
WHERE f.status IN ('pending', 'processing')
  AND (
    f.order_id::text     IN (SELECT id::text FROM shop_orders      WHERE order_status IN ('completed','cancelled','refunded'))
    OR f.order_id::text     IN (SELECT id::text FROM orders          WHERE status        IN ('completed','cancelled','refunded'))
    OR f.order_id::text     IN (SELECT id::text FROM ussd_orders     WHERE order_status  IN ('completed','cancelled','refunded'))
    OR f.order_id::text     IN (SELECT id::text FROM ussd_shop_orders WHERE order_status IN ('completed','cancelled','refunded'))
    OR f.api_order_id::text IN (SELECT id::text FROM api_orders      WHERE status        IN ('completed','cancelled','refunded'))
  );
