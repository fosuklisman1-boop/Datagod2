-- Update RLS policies for fulfillment_logs table
-- This migration updates the RLS policies to ensure system can properly insert/read/update logs

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Admins can read fulfillment logs" ON fulfillment_logs;
DROP POLICY IF EXISTS "System can insert fulfillment logs" ON fulfillment_logs;
DROP POLICY IF EXISTS "System can read fulfillment logs" ON fulfillment_logs;
DROP POLICY IF EXISTS "System can update fulfillment logs" ON fulfillment_logs;
DROP POLICY IF EXISTS "System can delete fulfillment logs" ON fulfillment_logs;

-- Ensure RLS is enabled
ALTER TABLE fulfillment_logs ENABLE ROW LEVEL SECURITY;

-- Create new permissive policies for system operations
CREATE POLICY "Allow system to insert fulfillment logs" ON fulfillment_logs
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow system to read fulfillment logs" ON fulfillment_logs
  FOR SELECT USING (true);

CREATE POLICY "Allow system to update fulfillment logs" ON fulfillment_logs
  FOR UPDATE USING (true);

CREATE POLICY "Allow system to delete fulfillment logs" ON fulfillment_logs
  FOR DELETE USING (true);
