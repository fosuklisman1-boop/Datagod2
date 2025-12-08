-- Add missing columns to afa_orders table if they don't exist
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS gh_card_number VARCHAR(50);
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS location VARCHAR(255);
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS region VARCHAR(100);
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS occupation VARCHAR(100);
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Create indexes for faster queries if they don't exist
CREATE INDEX IF NOT EXISTS idx_afa_orders_user_id ON afa_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_afa_orders_order_code ON afa_orders(order_code);
CREATE INDEX IF NOT EXISTS idx_afa_orders_transaction_code ON afa_orders(transaction_code);
CREATE INDEX IF NOT EXISTS idx_afa_orders_status ON afa_orders(status);
CREATE INDEX IF NOT EXISTS idx_afa_orders_created_at ON afa_orders(created_at);
