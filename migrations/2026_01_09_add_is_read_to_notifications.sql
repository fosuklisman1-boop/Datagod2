-- Add is_read column to notifications table
ALTER TABLE notifications
ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
