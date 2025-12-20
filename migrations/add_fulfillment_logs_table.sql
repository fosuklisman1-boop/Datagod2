-- Add fulfillment_logs table for tracking AT-iShare order fulfillment

CREATE TABLE fulfillment_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  network VARCHAR(100) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, processing, success, failed
  attempt_number INT NOT NULL DEFAULT 1,
  max_attempts INT NOT NULL DEFAULT 3,
  api_response JSONB,
  error_message TEXT,
  retry_after TIMESTAMP,
  fulfilled_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(order_id)
);

-- Enable RLS
ALTER TABLE fulfillment_logs ENABLE ROW LEVEL SECURITY;

-- System can insert fulfillment logs (using service role)
CREATE POLICY "System can insert fulfillment logs" ON fulfillment_logs
  FOR INSERT WITH CHECK (true);

-- System can read fulfillment logs
CREATE POLICY "System can read fulfillment logs" ON fulfillment_logs
  FOR SELECT USING (true);

-- System can update fulfillment logs
CREATE POLICY "System can update fulfillment logs" ON fulfillment_logs
  FOR UPDATE USING (true);

-- System can delete fulfillment logs
CREATE POLICY "System can delete fulfillment logs" ON fulfillment_logs
  FOR DELETE USING (true);

-- Add fulfillment_status column to orders table
ALTER TABLE orders ADD COLUMN fulfillment_status VARCHAR(50) DEFAULT 'pending';

-- Create indexes for performance
CREATE INDEX idx_fulfillment_logs_status ON fulfillment_logs(status);
CREATE INDEX idx_fulfillment_logs_network ON fulfillment_logs(network);
CREATE INDEX idx_fulfillment_logs_created_at ON fulfillment_logs(created_at DESC);
CREATE INDEX idx_fulfillment_logs_retry_after ON fulfillment_logs(retry_after);
CREATE INDEX idx_orders_fulfillment_status ON orders(fulfillment_status);
CREATE INDEX idx_orders_network_fulfillment ON orders(network, fulfillment_status);
