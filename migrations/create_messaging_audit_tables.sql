-- Email and Broadcast Audit Tables

-- Email Logs Table
CREATE TABLE IF NOT EXISTS email_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  message_type VARCHAR(50), -- broadcast, welcome, order_confirmation, etc.
  reference_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending', -- pending, sent, failed
  error_message TEXT,
  sent_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Broadcast Logs Table
CREATE TABLE IF NOT EXISTS broadcast_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES auth.users(id),
  channels JSONB NOT NULL, -- ["sms", "email"]
  target_type VARCHAR(50) NOT NULL, -- roles, specific
  target_group JSONB, -- ["shop_owner", "sub_agent"]
  subject VARCHAR(255),
  message TEXT NOT NULL,
  results JSONB, -- { total: 0, sms: {sent: 0, failed: 0}, email: {sent: 0, failed: 0} }
  status VARCHAR(20) DEFAULT 'completed',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_email_logs_user_id ON email_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);
CREATE INDEX IF NOT EXISTS idx_broadcast_logs_admin_id ON broadcast_logs(admin_id);

-- RLS
ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_logs ENABLE ROW LEVEL SECURITY;

-- Policies for email_logs
DROP POLICY IF EXISTS "Users can view their own email logs" ON email_logs;
CREATE POLICY "Users can view their own email logs"
  ON email_logs FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access on email_logs" ON email_logs;
CREATE POLICY "Service role full access on email_logs"
  ON email_logs FOR ALL
  USING (true)
  WITH CHECK (true);

-- Policies for broadcast_logs (Admins only)
DROP POLICY IF EXISTS "Admins can view broadcast logs" ON broadcast_logs;
CREATE POLICY "Admins can view broadcast logs"
  ON broadcast_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Service role full access on broadcast_logs" ON broadcast_logs;
CREATE POLICY "Service role full access on broadcast_logs"
  ON broadcast_logs FOR ALL
  USING (true)
  WITH CHECK (true);

-- Permissions
GRANT ALL ON email_logs TO service_role;
GRANT SELECT ON email_logs TO authenticated;
GRANT ALL ON broadcast_logs TO service_role;
GRANT SELECT ON broadcast_logs TO authenticated;
