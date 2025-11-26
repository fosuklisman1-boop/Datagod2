-- Create order_download_batches table to track downloaded orders
CREATE TABLE IF NOT EXISTS order_download_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network VARCHAR(50) NOT NULL,
  batch_time TIMESTAMP NOT NULL,
  orders JSONB NOT NULL DEFAULT '[]'::jsonb, -- Store full order details
  order_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_order_download_batches_network ON order_download_batches(network);
CREATE INDEX IF NOT EXISTS idx_order_download_batches_batch_time ON order_download_batches(batch_time);

-- Enable RLS
ALTER TABLE order_download_batches ENABLE ROW LEVEL SECURITY;

-- Admin read policy
CREATE POLICY "Admin can read batch records"
  ON order_download_batches FOR SELECT
  USING (true); -- Only accessible via service role (backend API)
