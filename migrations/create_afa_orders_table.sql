-- Create AFA Orders table
CREATE TABLE IF NOT EXISTS afa_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_code VARCHAR(50) UNIQUE NOT NULL,
  transaction_code VARCHAR(50) UNIQUE NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  gh_card_number VARCHAR(50),
  location VARCHAR(255),
  region VARCHAR(100),
  occupation VARCHAR(100),
  amount DECIMAL(10, 2) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_afa_orders_user_id ON afa_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_afa_orders_order_code ON afa_orders(order_code);
CREATE INDEX IF NOT EXISTS idx_afa_orders_transaction_code ON afa_orders(transaction_code);
CREATE INDEX IF NOT EXISTS idx_afa_orders_status ON afa_orders(status);
CREATE INDEX IF NOT EXISTS idx_afa_orders_created_at ON afa_orders(created_at);

-- Enable RLS
ALTER TABLE afa_orders ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Allow users to read their own AFA orders
CREATE POLICY "Users can read their own AFA orders" ON afa_orders
  FOR SELECT USING (auth.uid() = user_id);

-- Allow admins to read all AFA orders
CREATE POLICY "Admins can read all AFA orders" ON afa_orders
  FOR SELECT USING (
    auth.jwt() ->> 'role' = 'admin'
  );

-- Allow users to insert their own AFA orders
CREATE POLICY "Users can create their own AFA orders" ON afa_orders
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Allow admins to update AFA order status
CREATE POLICY "Admins can update AFA orders" ON afa_orders
  FOR UPDATE USING (
    auth.jwt() ->> 'role' = 'admin'
  );
