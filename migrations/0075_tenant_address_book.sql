-- 0075_tenant_address_book.sql
-- Give each tenant (sms_account) its own address book, mirroring the per-tenant
-- pattern already used for sender IDs (0072) and templates (0074): a NULLABLE
-- sms_account_id on sms_groups where NULL = admin/platform-global group and a
-- value = that tenant's group. Contacts inherit ownership transitively via
-- group_id (FK ON DELETE CASCADE), so sms_contacts needs NO owner column.
--
-- Also adds opt-in phone-name verification state to sms_contacts: tenants can
-- verify uploaded numbers against Moolre (the same /transact/validate name
-- lookup the withdrawal flow uses) to fetch the registered MoMo name.
--
-- RLS stays service-role-only (matching 0070/0072/0074); tenant scoping is
-- enforced in the service layer, NOT via owner-SELECT policies.

-- ── Per-tenant ownership on groups ──────────────────────────────────────────
ALTER TABLE sms_groups
  ADD COLUMN IF NOT EXISTS sms_account_id UUID REFERENCES sms_accounts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_sms_groups_account ON sms_groups(sms_account_id);

-- ── Opt-in contact verification (Moolre MoMo name lookup) ───────────────────
ALTER TABLE sms_contacts
  ADD COLUMN IF NOT EXISTS verify_status     TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verified_name     TEXT,
  ADD COLUMN IF NOT EXISTS verified_at       TIMESTAMPTZ,
  -- Lease timestamp so the client poll and the cron backstop don't both call the
  -- (slow, possibly-billed) Moolre lookup on the same row: a drain only claims a
  -- pending row whose claim is null or older than the lease window.
  ADD COLUMN IF NOT EXISTS verify_claimed_at TIMESTAMPTZ;

-- Constrain verify_status to the known states. Guarded so re-running is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sms_contacts_verify_status_chk'
  ) THEN
    ALTER TABLE sms_contacts
      ADD CONSTRAINT sms_contacts_verify_status_chk
      CHECK (verify_status IN ('unverified', 'pending', 'verified', 'invalid'));
  END IF;
END $$;

-- Fast lookup of the next contacts to verify within a group (drain queue).
CREATE INDEX IF NOT EXISTS idx_sms_contacts_verify_pending
  ON sms_contacts(group_id)
  WHERE verify_status = 'pending';
