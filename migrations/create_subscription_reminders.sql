-- Migration: Create subscription_reminders table
-- Purpose: Track which subscription expiry reminders have been sent to prevent duplicates

CREATE TABLE IF NOT EXISTS subscription_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES user_subscriptions(id) ON DELETE CASCADE,
  reminder_type VARCHAR(20) NOT NULL CHECK (reminder_type IN ('1day', '12hours', '6hours', '1hour')),
  sent_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  
  -- Ensure we don't send the same reminder twice
  CONSTRAINT unique_subscription_reminder UNIQUE (subscription_id, reminder_type)
);

-- Index for fast lookups when checking if reminder was sent
CREATE INDEX IF NOT EXISTS idx_subscription_reminders_lookup 
  ON subscription_reminders(subscription_id, reminder_type);

-- Index for querying by sent date
CREATE INDEX IF NOT EXISTS idx_subscription_reminders_sent_at 
  ON subscription_reminders(sent_at DESC);

-- Grant permissions
GRANT SELECT, INSERT ON subscription_reminders TO authenticated;
GRANT SELECT, INSERT ON subscription_reminders TO service_role;

COMMENT ON TABLE subscription_reminders IS 'Tracks which subscription expiry reminder SMS messages have been sent';
COMMENT ON COLUMN subscription_reminders.reminder_type IS 'Type of reminder: 1day, 12hours, 6hours, or 1hour before expiry';
