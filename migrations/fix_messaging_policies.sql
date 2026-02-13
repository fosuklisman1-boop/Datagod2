-- Admin Policies for Messaging Logs
-- Allows admins to see all logs, not just their own

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
