-- 20260615_fix_broken_rls_sensitive_tables.sql
--
-- SECURITY FIX (HIGH) — broken RLS on sensitive tables.
--
-- ROOT CAUSE
-- Several tables ENABLEd RLS but wrote their "service role" policy as
-- `FOR ALL USING (true)` WITHOUT a `TO service_role` clause. A Postgres policy
-- with no role clause applies to EVERY role (anon, authenticated, service_role),
-- and 0060_restore_public_grants.sql granted `authenticated` SELECT/INSERT/
-- UPDATE/DELETE on ALL public tables. So any logged-in user could hit the public
-- PostgREST endpoint with the anon key + their own JWT and read/modify these
-- tables directly — bypassing the service-role API layer the app relies on.
--
-- Example exploit (pre-fix): sign up for any account, then
--   GET /rest/v1/results_check_requests?select=*
--   apikey: <NEXT_PUBLIC_SUPABASE_ANON_KEY>
--   Authorization: Bearer <attacker_jwt>
-- returned every customer's phone, index number, DOB, exam results, and combo
-- voucher PIN/serial.
--
-- FIX
-- Re-scope the over-broad policies to `TO service_role` (service_role bypasses
-- RLS anyway, so this expresses the real "backend-only" intent) and add explicit
-- admin/owner read policies where the dashboard reads a table directly with the
-- authenticated key. Mirrors the already-correct patterns in
-- create_broadcast_recipients.sql and 0044_create_results_checker_orders.sql.
--
-- Effect: service_role unaffected; admins keep their dashboard views; ordinary
-- authenticated users lose the unintended cross-tenant access. Idempotent.

BEGIN;

-- ===========================================================================
-- 1) results_check_requests (HIGH) — PII + combo voucher PIN/serial + results.
--    Accessed ONLY by service-role code (lib/*, app/api/*); no direct
--    authenticated read path exists, so authenticated needs no row access
--    beyond an admin debugging read.
-- ===========================================================================
DROP POLICY IF EXISTS "admin_full_access_results_check_requests" ON results_check_requests;

DROP POLICY IF EXISTS "service_role_full_access_results_check_requests" ON results_check_requests;
CREATE POLICY "service_role_full_access_results_check_requests"
  ON results_check_requests FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admins_read_results_check_requests" ON results_check_requests;
CREATE POLICY "admins_read_results_check_requests"
  ON results_check_requests FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'admin'));

-- ===========================================================================
-- 2) whatsapp_messages / whatsapp_conversations — full customer chat history +
--    phone numbers. Admin SELECT policies already exist (added in
--    20260525_whatsapp_ai_messaging.sql); only the over-broad service policy
--    needs the role clause.
-- ===========================================================================
DROP POLICY IF EXISTS "Service role full access on whatsapp messages" ON whatsapp_messages;
CREATE POLICY "Service role full access on whatsapp messages"
  ON whatsapp_messages FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on whatsapp conversations" ON whatsapp_conversations;
CREATE POLICY "Service role full access on whatsapp conversations"
  ON whatsapp_conversations FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ===========================================================================
-- 3) email_logs — recipient emails + subjects. Has an owner-read policy but NO
--    admin policy, and the admin dashboard reads it directly with the
--    authenticated key (lib/admin-service.ts adminMessagingService.getEmailLogs).
--    Re-scope the service policy AND add an explicit admin-read policy so the
--    admin view keeps working.
-- ===========================================================================
DROP POLICY IF EXISTS "Service role full access on email_logs" ON email_logs;
CREATE POLICY "Service role full access on email_logs"
  ON email_logs FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can view all email logs" ON email_logs;
CREATE POLICY "Admins can view all email logs"
  ON email_logs FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'admin'));

-- ===========================================================================
-- 4) broadcast_logs — broadcast message bodies + admin_id. Admin SELECT policy
--    already exists; only the over-broad service policy needs the role clause.
-- ===========================================================================
DROP POLICY IF EXISTS "Service role full access on broadcast_logs" ON broadcast_logs;
CREATE POLICY "Service role full access on broadcast_logs"
  ON broadcast_logs FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ===========================================================================
-- 5) Write-tampering hardening. SELECT on these tables is already owner-scoped
--    (safe to read), but their INSERT/UPDATE policies were `USING/WITH CHECK
--    (true)` with no role clause, letting any authenticated user forge or alter
--    rows (audit-log poisoning, tampering with another shop's customer metrics).
--    Every writer is service-role (lib/sms-service.ts,
--    lib/customer-tracking-service.ts), so scope these to service_role.
-- ===========================================================================
DROP POLICY IF EXISTS "Service role can insert SMS logs" ON sms_logs;
CREATE POLICY "Service role can insert SMS logs"
  ON sms_logs FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can update SMS logs" ON sms_logs;
CREATE POLICY "Service role can update SMS logs"
  ON sms_logs FOR UPDATE
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "System can insert shop customers" ON shop_customers;
CREATE POLICY "System can insert shop customers"
  ON shop_customers FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "System can update shop customers" ON shop_customers;
CREATE POLICY "System can update shop customers"
  ON shop_customers FOR UPDATE
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "System can insert customer tracking" ON customer_tracking;
CREATE POLICY "System can insert customer tracking"
  ON customer_tracking FOR INSERT
  TO service_role
  WITH CHECK (true);

COMMIT;

-- ===========================================================================
-- POST-APPLY VERIFICATION
-- Run as a NON-admin authenticated user (or via the anon key + a normal user's
-- JWT). Each of these MUST now return 0 rows / permission denied:
--   select * from results_check_requests;
--   select * from whatsapp_messages;
--   select * from email_logs;
-- And as an ADMIN authenticated user these MUST still work:
--   select count(*) from email_logs;      -- admin dashboard view
--   select count(*) from broadcast_logs;  -- broadcast history view
--
-- Audit query — list any remaining table policies with no role restriction
-- (roles = {public}) that allow a true predicate; review each:
--   SELECT schemaname, tablename, policyname, roles, cmd, qual
--     FROM pg_policies
--    WHERE schemaname = 'public'
--      AND roles = '{public}'
--      AND (qual = 'true' OR with_check = 'true')
--    ORDER BY tablename, policyname;
-- ===========================================================================
