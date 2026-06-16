-- migrations/0074_tenant_sms_templates.sql
-- Per-tenant message templates (the "Save as template" / "Message Templates" UI).
-- sms_templates was admin-global (0070). Add a nullable owner so shop owners /
-- sub-agents get their OWN templates while admin templates stay global.
--   sms_account_id NULL     → admin/platform-global template (admin SMS Centre)
--   sms_account_id = <acct> → that tenant's template
-- RLS stays service-role-only; tenant access is via service-role routes scoped
-- by sms_account_id.

ALTER TABLE sms_templates
  ADD COLUMN IF NOT EXISTS sms_account_id UUID REFERENCES sms_accounts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_sms_templates_account ON sms_templates(sms_account_id);
