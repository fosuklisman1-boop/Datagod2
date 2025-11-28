-- Create shop_available_balance table to track available balance history
CREATE TABLE IF NOT EXISTS shop_available_balance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL UNIQUE REFERENCES user_shops(id) ON DELETE CASCADE,
  available_balance DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total_profit DECIMAL(10, 2) NOT NULL DEFAULT 0,
  withdrawn_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  pending_profit DECIMAL(10, 2) NOT NULL DEFAULT 0,
  credited_profit DECIMAL(10, 2) NOT NULL DEFAULT 0,
  withdrawn_profit DECIMAL(10, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_shop_available_balance_shop_id ON shop_available_balance(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_available_balance_updated_at ON shop_available_balance(updated_at DESC);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON shop_available_balance TO authenticated;
GRANT SELECT, INSERT, UPDATE ON shop_available_balance TO service_role;
