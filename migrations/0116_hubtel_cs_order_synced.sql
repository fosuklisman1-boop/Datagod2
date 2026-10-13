-- 0116_hubtel_cs_order_synced.sql
-- Records when a settled ledger row's order hook succeeded, so the status cron can re-run
-- hooks that failed (adapter threw / not registered at the time). ADDITIVE.
ALTER TABLE hubtel_cs_transactions ADD COLUMN IF NOT EXISTS order_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS hubtel_cs_tx_unsynced_idx
  ON hubtel_cs_transactions (updated_at)
  WHERE order_table IS NOT NULL AND order_synced_at IS NULL AND state IN ('fulfilled', 'failed');
