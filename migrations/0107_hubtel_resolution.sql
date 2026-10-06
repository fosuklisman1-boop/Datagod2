-- 0107_hubtel_resolution.sql
-- Admin "mark resolved" for needs_review Hubtel rows: why, who, when.
-- Columns only: hubtel_transactions stays service-role only (no policies, see 0106).
ALTER TABLE hubtel_transactions
  ADD COLUMN IF NOT EXISTS resolution_note text,
  ADD COLUMN IF NOT EXISTS resolved_by     uuid,
  ADD COLUMN IF NOT EXISTS resolved_at     timestamptz;
