-- Track per-number whitelist verification status from Xpress / Codecraft.
-- Kept separate from the existing 'status' column (MTN registration gate)
-- so the two flows don't interfere.
ALTER TABLE mtn_number_registry
  ADD COLUMN IF NOT EXISTS whitelist_status        text DEFAULT 'unchecked',
  ADD COLUMN IF NOT EXISTS whitelist_retry_count   int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whitelist_last_checked  timestamptz,
  ADD COLUMN IF NOT EXISTS whitelist_allowed_by    text; -- 'xpress' | 'codecraft' | null

-- Index for the retry cron query (blocked numbers not yet exhausted)
CREATE INDEX IF NOT EXISTS mtn_registry_whitelist_retry_idx
  ON mtn_number_registry (whitelist_status, whitelist_retry_count, whitelist_last_checked)
  WHERE whitelist_status = 'blocked';
