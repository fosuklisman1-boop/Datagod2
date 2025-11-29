-- Migration: Add admin complaint update policies
-- Purpose: Allow admins to read and update all complaints

-- Admins can read all complaints
CREATE POLICY "Admins can read all complaints" ON complaints
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

-- Admins can update all complaints
CREATE POLICY "Admins can update all complaints" ON complaints
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );
