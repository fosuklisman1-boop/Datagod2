-- Add fulfillment_logs table for tracking AT-iShare order fulfillment
-- NOTE: If table already exists, this migration will be skipped by Supabase

CREATE TABLE IF NOT EXISTS fulfillment_logs (
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

-- Add fulfillment_status column to orders table if it doesn't exist
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status VARCHAR(50) DEFAULT 'pending';

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_fulfillment_logs_status ON fulfillment_logs(status);
CREATE INDEX IF NOT EXISTS idx_fulfillment_logs_network ON fulfillment_logs(network);
CREATE INDEX IF NOT EXISTS idx_fulfillment_logs_created_at ON fulfillment_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fulfillment_logs_retry_after ON fulfillment_logs(retry_after);
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_status ON orders(fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_orders_network_fulfillment ON orders(network, fulfillment_status);
