-- Add unique constraint on phone_number in users table
-- This ensures one phone number can only be used for one account

-- First, check if there are any duplicate phone numbers and handle them
-- (This is a safeguard - duplicates should be manually reviewed before running this)

-- Add unique constraint
ALTER TABLE users ADD CONSTRAINT users_phone_number_unique UNIQUE (phone_number);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);

-- Comment
COMMENT ON CONSTRAINT users_phone_number_unique ON users IS 'Ensures one phone number per account';
