-- 1. Safely update mtn_fulfillment_tracking
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='mtn_fulfillment_tracking' AND column_name='api_order_id') THEN
    ALTER TABLE mtn_fulfillment_tracking ADD COLUMN api_order_id UUID REFERENCES api_orders(id) ON DELETE SET NULL;
    CREATE INDEX idx_mtn_fulfillment_api_order_id ON mtn_fulfillment_tracking(api_order_id);
  END IF;
END $$;

-- 2. Safely update fulfillment_logs
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'fulfillment_logs') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='fulfillment_logs' AND column_name='api_order_id') THEN
            ALTER TABLE fulfillment_logs ADD COLUMN api_order_id UUID REFERENCES api_orders(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS idx_fulfillment_logs_api_order_id ON fulfillment_logs(api_order_id);
        END IF;
    END IF;
END $$;

-- 3. Update comments (safe to re-run)
COMMENT ON COLUMN mtn_fulfillment_tracking.api_order_id IS 'Reference to api_orders.id for programmatic API orders';
COMMENT ON COLUMN mtn_fulfillment_tracking.shop_order_id IS 'Reference to shop_orders.id for storefront orders';
COMMENT ON COLUMN mtn_fulfillment_tracking.order_id IS 'Reference to orders.id for bulk/data package orders';
