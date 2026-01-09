-- Create blacklisted_phone_numbers table
CREATE TABLE IF NOT EXISTS blacklisted_phone_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  reason TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_blacklist_phone ON blacklisted_phone_numbers(phone_number);
CREATE INDEX IF NOT EXISTS idx_blacklist_created_at ON blacklisted_phone_numbers(created_at DESC);
