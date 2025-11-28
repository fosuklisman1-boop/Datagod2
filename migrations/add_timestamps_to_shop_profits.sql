-- Add updated_at column to shop_profits table
ALTER TABLE shop_profits ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Add withdrawn_at column to shop_profits table for tracking withdrawals
ALTER TABLE shop_profits ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMP WITH TIME ZONE;

-- Create index on status for faster queries
CREATE INDEX IF NOT EXISTS idx_shop_profits_status ON shop_profits(status);
CREATE INDEX IF NOT EXISTS idx_shop_profits_shop_id ON shop_profits(shop_id);
