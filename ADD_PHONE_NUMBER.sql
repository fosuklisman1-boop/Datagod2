-- Add phone_number column to users table
ALTER TABLE users 
ADD COLUMN phone_number VARCHAR(20);

-- Update existing records to use phone_number if needed
-- (optional - only if you want to migrate data from phone column)
-- UPDATE users SET phone_number = phone WHERE phone IS NOT NULL;
