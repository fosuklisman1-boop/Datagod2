-- Migration: Create MTN fulfillment tracking table
-- Purpose: Track all MTN API orders and their status
-- Created: 2026-01-05

CREATE TABLE IF NOT EXISTS public.mtn_fulfillment_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_order_id UUID NOT NULL REFERENCES public.shop_orders(id) ON DELETE CASCADE,
  mtn_order_id INTEGER UNIQUE,
  api_request_payload JSONB,
  api_response_payload JSONB,
  webhook_payload JSONB,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  recipient_phone VARCHAR(20),
  network VARCHAR(20),
  size_gb INTEGER,
  external_status VARCHAR(50),
  external_message TEXT,
  retry_count INTEGER DEFAULT 0,
  last_retry_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  webhook_received_at TIMESTAMP,
  
  CONSTRAINT valid_status CHECK (status IN ('pending', 'completed', 'failed', 'error', 'retrying')),
  CONSTRAINT valid_network CHECK (network IN ('MTN', 'Telecel', 'AirtelTigo'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_mtn_fulfillment_shop_order_id ON public.mtn_fulfillment_tracking(shop_order_id);
CREATE INDEX IF NOT EXISTS idx_mtn_fulfillment_mtn_order_id ON public.mtn_fulfillment_tracking(mtn_order_id);
CREATE INDEX IF NOT EXISTS idx_mtn_fulfillment_status ON public.mtn_fulfillment_tracking(status);
CREATE INDEX IF NOT EXISTS idx_mtn_fulfillment_created_at ON public.mtn_fulfillment_tracking(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mtn_fulfillment_retry_needed ON public.mtn_fulfillment_tracking(status, last_retry_at) WHERE status IN ('pending', 'retrying');

-- Add trigger for updated_at
CREATE OR REPLACE FUNCTION update_mtn_fulfillment_tracking_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mtn_fulfillment_tracking_updated_at_trigger
BEFORE UPDATE ON public.mtn_fulfillment_tracking
FOR EACH ROW
EXECUTE FUNCTION update_mtn_fulfillment_tracking_updated_at();
