-- migrations/0070_admin_broadcast_address_book.sql
-- Bulk SMS Milestone 5: admin broadcast extension (UN-METERED — no credit ledger here).
--   sms_groups / sms_contacts : address book (contacts grouped, per-group dedupe, opt-out)
--   sms_templates             : global reusable templates
--   sms_sender_ids            : admin-managed Moolre-registered sender IDs (submit + poll)
--   admin_settings rows       : DB-configurable provider routing (primary + fallbacks)
-- All address-book tables are service-role only (the in-route admin check is the boundary).

CREATE TABLE IF NOT EXISTS sms_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_groups_name ON sms_groups(name);
ALTER TABLE sms_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_sms_groups" ON sms_groups;
CREATE POLICY "service_role_sms_groups" ON sms_groups
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS sms_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES sms_groups(id) ON DELETE CASCADE,
  first_name   TEXT,
  last_name    TEXT,
  phone_number TEXT NOT NULL,                 -- stored normalised (0XXXXXXXXX)
  opted_out    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, phone_number)             -- idempotent per-group dedupe
);
CREATE INDEX IF NOT EXISTS idx_sms_contacts_group ON sms_contacts(group_id);
CREATE INDEX IF NOT EXISTS idx_sms_contacts_phone ON sms_contacts(phone_number);
CREATE INDEX IF NOT EXISTS idx_sms_contacts_active ON sms_contacts(group_id) WHERE opted_out = false;
ALTER TABLE sms_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_sms_contacts" ON sms_contacts;
CREATE POLICY "service_role_sms_contacts" ON sms_contacts
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS sms_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sms_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_sms_templates" ON sms_templates;
CREATE POLICY "service_role_sms_templates" ON sms_templates
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS sms_sender_ids (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id      TEXT NOT NULL UNIQUE CHECK (char_length(sender_id) BETWEEN 1 AND 11),
  moolre_status  TEXT,
  local_status   TEXT NOT NULL DEFAULT 'pending' CHECK (local_status IN ('pending','active','rejected')),
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_sender_ids_status ON sms_sender_ids(local_status);
ALTER TABLE sms_sender_ids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_sms_sender_ids" ON sms_sender_ids;
CREATE POLICY "service_role_sms_sender_ids" ON sms_sender_ids
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- DB-configurable provider routing (admin_settings.value is JSONB). Idempotent, no
-- dependence on a UNIQUE(key) constraint.
INSERT INTO admin_settings (key, value)
SELECT v.key, v.value
FROM (VALUES
  ('sms_primary_provider',   '"moolre"'::jsonb),
  ('sms_fallback_providers', '["mnotify"]'::jsonb)
) AS v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM admin_settings s WHERE s.key = v.key);
