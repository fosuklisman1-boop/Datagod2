-- Migration: Add dealer_price column to packages table
-- This allows admins to set a special price for users with the 'dealer' role

-- Add dealer_price column (nullable, defaults to NULL meaning dealer price not set)
ALTER TABLE packages ADD COLUMN IF NOT EXISTS dealer_price NUMERIC(10, 2);

-- Update comment for role column to include 'dealer'
COMMENT ON COLUMN users.role IS 'User role: admin, user, sub_agent, or dealer';

-- Create index for efficient dealer pricing lookups
CREATE INDEX IF NOT EXISTS idx_packages_dealer_price ON packages(dealer_price) WHERE dealer_price IS NOT NULL;
