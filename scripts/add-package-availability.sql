-- Add availability field to packages table
-- Run this SQL in your Supabase SQL Editor

ALTER TABLE packages
ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT TRUE;

-- Add comment to column
COMMENT ON COLUMN packages.is_available IS 'Whether this package is available for purchase';

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_packages_is_available ON packages(is_available);
