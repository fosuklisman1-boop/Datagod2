-- Update tracking tables to support api_orders
ALTER TABLE mtn_fulfillment_tracking ADD COLUMN api_order_id UUID REFERENCES api_orders(id) ON DELETE SET NULL;
CREATE INDEX idx_mtn_fulfillment_api_order_id ON mtn_fulfillment_tracking(api_order_id);

-- Check if fulfillment_logs exists and update it
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'fulfillment_logs') THEN
        ALTER TABLE fulfillment_logs ADD COLUMN api_order_id UUID REFERENCES api_orders(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_fulfillment_logs_api_order_id ON fulfillment_logs(api_order_id);
    END IF;
END $$;

-- Update comments
COMMENT ON COLUMN mtn_fulfillment_tracking.api_order_id IS 'Reference to api_orders.id for programmatic API orders';
COMMENT ON COLUMN mtn_fulfillment_tracking.shop_order_id IS 'Reference to shop_orders.id for storefront orders';
COMMENT ON COLUMN mtn_fulfillment_tracking.order_id IS 'Reference to orders.id for bulk/data package orders';
-- Note: We don't change the order_type constraint here because it's often a TEXT check in application logic or a simple CHECK constraint
