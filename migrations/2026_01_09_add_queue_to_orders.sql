-- Add queue column to orders table
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS queue VARCHAR(50) DEFAULT 'default';

-- Create index on queue for filtering
CREATE INDEX IF NOT EXISTS idx_orders_queue ON orders(queue);
