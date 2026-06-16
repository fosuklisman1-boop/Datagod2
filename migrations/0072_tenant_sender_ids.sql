-- migrations/0072_tenant_sender_ids.sql
-- Per-tenant sender IDs (restores the original spec intent).
--
-- M5's 0070 created sms_sender_ids as admin-GLOBAL (no owner), so shop owners /
-- sub-agents had no way to request their own sender ID. Add a nullable owner and
-- switch uniqueness from global to per-account.
--
--   sms_account_id NULL      → platform/admin-global sender ID (admin SMS Centre)
--   sms_account_id = <acct>  → that tenant's requested sender ID
--
-- The existing sms-senderid-poll cron reconciles EVERY pending row regardless of
-- owner, so tenant sender IDs get status updates with no new cron.

ALTER TABLE sms_sender_ids
  ADD COLUMN IF NOT EXISTS sms_account_id UUID REFERENCES sms_accounts(id) ON DELETE CASCADE;

-- Replace the global UNIQUE(sender_id) with per-account uniqueness. A multi-column
-- unique index treats NULLs as distinct, so admin-global rows keep their own
-- single-registration guarantee via a partial unique index.
ALTER TABLE sms_sender_ids DROP CONSTRAINT IF EXISTS sms_sender_ids_sender_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_sender_ids_account_sender
  ON sms_sender_ids(sms_account_id, sender_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_sender_ids_global_sender
  ON sms_sender_ids(sender_id) WHERE sms_account_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_sms_sender_ids_account ON sms_sender_ids(sms_account_id);

-- RLS unchanged: sms_sender_ids stays service-role-only (0070). Tenant reads/writes
-- go through service-role API routes scoped by sms_account_id, so no tenant policy
-- is added (avoids the bare-USING(true) exposure class from the RLS audit).
