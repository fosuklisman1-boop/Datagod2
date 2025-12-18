-- SMS Logs Table
-- Tracks all SMS messages sent to users for audit and debugging

CREATE TABLE IF NOT EXISTS sms_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  phone_number VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  message_type VARCHAR(50),
  reference_id VARCHAR(100),
  moolre_message_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending', -- pending, sent, failed, delivered
  error_message TEXT,
  sent_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for common queries
CREATE INDEX idx_sms_user_id ON sms_logs(user_id);
CREATE INDEX idx_sms_phone ON sms_logs(phone_number);
CREATE INDEX idx_sms_sent_at ON sms_logs(sent_at);
CREATE INDEX idx_sms_status ON sms_logs(status);
CREATE INDEX idx_sms_message_type ON sms_logs(message_type);
CREATE INDEX idx_sms_reference_id ON sms_logs(reference_id);

-- Enable RLS
ALTER TABLE sms_logs ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view their own SMS logs"
  ON sms_logs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can insert SMS logs"
  ON sms_logs FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role can update SMS logs"
  ON sms_logs FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON sms_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON sms_logs TO service_role;
