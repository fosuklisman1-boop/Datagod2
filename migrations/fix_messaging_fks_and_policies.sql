-- Consolidated Fix for Messaging History Access
-- 1. Updates Foreign Keys to point to public.users (allowing joins)
-- 2. Updates RLS policies to allow Admins to view all logs

-- Fix Foreign Keys to reference public.users for PostgREST joins
-- CLEANUP: Remove orphaned records first to prevent foreign key errors
DELETE FROM email_logs WHERE user_id NOT IN (SELECT id FROM public.users);
DELETE FROM broadcast_logs WHERE admin_id NOT IN (SELECT id FROM public.users);
DELETE FROM sms_logs WHERE user_id NOT IN (SELECT id FROM public.users);

-- email_logs
ALTER TABLE email_logs DROP CONSTRAINT IF EXISTS email_logs_user_id_fkey;
ALTER TABLE email_logs ADD CONSTRAINT email_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- broadcast_logs
ALTER TABLE broadcast_logs DROP CONSTRAINT IF EXISTS broadcast_logs_admin_id_fkey;
ALTER TABLE broadcast_logs ADD CONSTRAINT broadcast_logs_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- sms_logs
ALTER TABLE sms_logs DROP CONSTRAINT IF EXISTS sms_logs_user_id_fkey;
ALTER TABLE sms_logs ADD CONSTRAINT sms_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- RLS Policies - Allow Admins to View All Logs

-- email_logs
DROP POLICY IF EXISTS "Admins can view all email logs" ON email_logs;
CREATE POLICY "Admins can view all email logs"
  ON email_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

-- sms_logs
DROP POLICY IF EXISTS "Admins can view all sms logs" ON sms_logs;
CREATE POLICY "Admins can view all sms logs"
  ON sms_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

-- ensure broadcast_logs is also correct
DROP POLICY IF EXISTS "Admins can view broadcast logs" ON broadcast_logs;
CREATE POLICY "Admins can view broadcast logs"
  ON broadcast_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );
