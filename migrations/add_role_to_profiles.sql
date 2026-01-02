-- Migration: Add role column to users table (if not exists)
-- This allows distinguishing between admin, user, and sub_agent roles

-- Add role column to users table (it may already exist with 'admin' and 'user' values)
-- This just ensures the column exists and updates NULL values
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';

-- Create index for role lookups
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Update existing users to have 'user' role if not set
UPDATE users SET role = 'user' WHERE role IS NULL;

-- Comment for documentation
COMMENT ON COLUMN users.role IS 'User role: admin, user, or sub_agent';
