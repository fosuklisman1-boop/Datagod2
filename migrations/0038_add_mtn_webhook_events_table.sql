-- Migration: Add MTN webhook events table for audit trail
-- This table stores all incoming MTN webhooks for debugging and audit purposes

-- Create webhook events table
CREATE TABLE IF NOT EXISTS public.mtn_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id VARCHAR(50) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  mtn_order_id BIGINT,
  payload JSONB NOT NULL,
  raw_body TEXT,
  processed BOOLEAN DEFAULT false,
  processing_error TEXT,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_mtn_webhook_events_trace_id 
  ON public.mtn_webhook_events(trace_id);

CREATE INDEX IF NOT EXISTS idx_mtn_webhook_events_mtn_order_id 
  ON public.mtn_webhook_events(mtn_order_id);

CREATE INDEX IF NOT EXISTS idx_mtn_webhook_events_event_type 
  ON public.mtn_webhook_events(event_type);

CREATE INDEX IF NOT EXISTS idx_mtn_webhook_events_received_at 
  ON public.mtn_webhook_events(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_mtn_webhook_events_processed 
  ON public.mtn_webhook_events(processed) WHERE processed = false;

-- Enable RLS
ALTER TABLE public.mtn_webhook_events ENABLE ROW LEVEL SECURITY;

-- Only allow service role to access (webhooks are server-side only)
CREATE POLICY "Service role can manage webhook events"
  ON public.mtn_webhook_events
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Add columns to mtn_fulfillment_tracking if not exist
DO $$ 
BEGIN
  -- Add retry tracking columns
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'mtn_fulfillment_tracking' AND column_name = 'retry_count') THEN
    ALTER TABLE public.mtn_fulfillment_tracking ADD COLUMN retry_count INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'mtn_fulfillment_tracking' AND column_name = 'last_retry_at') THEN
    ALTER TABLE public.mtn_fulfillment_tracking ADD COLUMN last_retry_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'mtn_fulfillment_tracking' AND column_name = 'webhook_payload') THEN
    ALTER TABLE public.mtn_fulfillment_tracking ADD COLUMN webhook_payload JSONB;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'mtn_fulfillment_tracking' AND column_name = 'webhook_received_at') THEN
    ALTER TABLE public.mtn_fulfillment_tracking ADD COLUMN webhook_received_at TIMESTAMPTZ;
  END IF;

  -- Add failure tracking to shop_orders
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shop_orders' AND column_name = 'failure_reason') THEN
    ALTER TABLE public.shop_orders ADD COLUMN failure_reason TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shop_orders' AND column_name = 'completed_at') THEN
    ALTER TABLE public.shop_orders ADD COLUMN completed_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shop_orders' AND column_name = 'external_order_id') THEN
    ALTER TABLE public.shop_orders ADD COLUMN external_order_id VARCHAR(100);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shop_orders' AND column_name = 'fulfillment_method') THEN
    ALTER TABLE public.shop_orders ADD COLUMN fulfillment_method VARCHAR(20);
  END IF;
END $$;

-- Create function to clean up old webhook events (retention: 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_webhook_events()
RETURNS void AS $$
BEGIN
  DELETE FROM public.mtn_webhook_events 
  WHERE received_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- Comment for documentation
COMMENT ON TABLE public.mtn_webhook_events IS 'Audit trail for all MTN API webhooks. Retention: 30 days.';
COMMENT ON COLUMN public.mtn_webhook_events.trace_id IS 'Unique trace ID for request tracking across logs';
COMMENT ON COLUMN public.mtn_webhook_events.raw_body IS 'Original webhook body for signature verification debugging';
