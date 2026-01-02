-- Migration: Add role column to profiles table
-- This allows distinguishing between admin, user, and sub_agent roles

-- Add role column to profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';

-- Create index for role lookups
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);

-- Update existing users to have 'user' role if not set
UPDATE profiles SET role = 'user' WHERE role IS NULL;

-- Comment for documentation
COMMENT ON COLUMN profiles.role IS 'User role: admin, user, or sub_agent';
