-- 20260615_fix_admin_settings_public_read.sql
--
-- SECURITY FIX (HIGH) — admin_settings was world-readable by any authenticated user.
--
-- ROOT CAUSE
-- The policy "Service role can read admin_settings" was mis-scoped to roles
-- {public} with USING(true) instead of `TO service_role`. Combined with
-- 0060_restore_public_grants.sql (authenticated has SELECT on all public tables),
-- ANY logged-in user could read the entire admin_settings table via the public
-- PostgREST endpoint with their own JWT.
--
-- admin_settings stores, among other config, the key `ai_provider_config` which
-- holds LIVE LLM provider API keys (anthropic_api_key, openai_api_key,
-- gemini_api_key, deepseek_api_key, groq_api_key — see lib/ai-provider-config.ts),
-- plus results_check_admin_phones, fees, MTN provider selection, etc.
--
-- app/api/public/config/route.ts already documents that admin_settings is meant
-- to be "locked to service_role" and exposes only an allowlist server-side. All
-- other access is via service-role (lib/*, app/api/*). So authenticated needs no
-- direct read — realign the policy with that intent.
--
-- order_download_batches had the same mis-scoped public read. The admin dashboard
-- reads it with the authenticated browser client (lib/admin-service.ts
-- getDownloadBatches), so give it an admin-scoped read rather than a hard lock.
--
-- ⚠ ACTION REQUIRED AFTER APPLYING: ROTATE the exposed provider API keys
-- (Anthropic, OpenAI, Gemini, and any others stored). They were readable by every
-- registered user for as long as the mis-scoped policy existed and must be
-- treated as compromised.

BEGIN;

-- admin_settings: remove the public read; backend uses service_role (bypasses RLS).
DROP POLICY IF EXISTS "Service role can read admin_settings" ON admin_settings;
CREATE POLICY "Service role can read admin_settings"
  ON admin_settings FOR SELECT
  TO service_role
  USING (true);

-- order_download_batches: public read -> admin-scoped read (keeps the admin
-- dashboard's direct browser read working; service_role bypasses RLS anyway).
DROP POLICY IF EXISTS "Admin can read batch records" ON order_download_batches;
CREATE POLICY "Admin can read batch records"
  ON order_download_batches FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'admin'));

COMMIT;

-- Verify (must be {service_role} for admin_settings read; {authenticated}+predicate
-- for order_download_batches):
--   SELECT tablename, policyname, roles::text, cmd, (qual='true') AS qual_true
--     FROM pg_policies
--    WHERE schemaname='public' AND tablename IN ('admin_settings','order_download_batches')
--    ORDER BY tablename, policyname;
