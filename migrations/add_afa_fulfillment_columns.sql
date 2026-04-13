-- Add fulfillment tracking columns to afa_orders
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS fulfillment_status VARCHAR(50) DEFAULT 'unfulfilled';
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS fulfillment_ref VARCHAR(255);
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS fulfillment_error TEXT;
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS fulfillment_attempts INT DEFAULT 0;

-- Add check constraint for fulfillment_status values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'afa_orders_fulfillment_status_check'
      AND table_name = 'afa_orders'
  ) THEN
    ALTER TABLE afa_orders
      ADD CONSTRAINT afa_orders_fulfillment_status_check
      CHECK (fulfillment_status IN ('unfulfilled', 'pending', 'fulfilled', 'failed'));
  END IF;
END $$;

-- Backfill existing rows that have NULL fulfillment_status
UPDATE afa_orders SET fulfillment_status = 'unfulfilled' WHERE fulfillment_status IS NULL;

-- Index for querying unfulfilled orders efficiently
CREATE INDEX IF NOT EXISTS idx_afa_orders_fulfillment_status ON afa_orders(fulfillment_status);

-- Seed the AFA auto-fulfillment setting (disabled by default)
INSERT INTO admin_settings (key, value, description)
VALUES (
  'afa_auto_fulfillment_enabled',
  '{"enabled": false}'::jsonb,
  'Controls whether AFA orders are automatically submitted to Sykes API on placement'
)
ON CONFLICT (key) DO NOTHING;
