-- Create payment_attempts table for tracking all payment attempts
-- This is separate from transactions (which only contains actual money movements)

CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reference TEXT UNIQUE NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  fee DECIMAL(10, 2) DEFAULT 0,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'abandoned')),
  payment_type TEXT NOT NULL DEFAULT 'wallet_topup' CHECK (payment_type IN ('wallet_topup', 'shop_order')),
  shop_id UUID REFERENCES user_shops(id) ON DELETE SET NULL,
  order_id UUID,
  gateway_response TEXT,
  paystack_transaction_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_payment_attempts_user_id ON payment_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON payment_attempts(status);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_created_at ON payment_attempts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_reference ON payment_attempts(reference);

-- Enable RLS
ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;

-- Admin can see all
CREATE POLICY "Admin can view all payment attempts"
  ON payment_attempts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
      AND auth.users.raw_user_meta_data->>'role' = 'admin'
    )
  );

-- Users can see their own attempts
CREATE POLICY "Users can view own payment attempts"
  ON payment_attempts FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can insert/update (for API routes)
CREATE POLICY "Service can insert payment attempts"
  ON payment_attempts FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service can update payment attempts"
  ON payment_attempts FOR UPDATE
  USING (true);

-- Grant permissions
GRANT SELECT ON payment_attempts TO authenticated;
GRANT INSERT, UPDATE ON payment_attempts TO service_role;
