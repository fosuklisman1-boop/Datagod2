-- Adds provider tracking to AFA registration orders so a second provider
-- (Apex Prime, wallet-funded, async) can run alongside the existing
-- Sykes-only (synchronous) integration. Existing rows default to 'sykes' —
-- the only provider that has ever run.

ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS fulfillment_provider VARCHAR(20) NOT NULL DEFAULT 'sykes';
ALTER TABLE ussd_afa_orders ADD COLUMN IF NOT EXISTS fulfillment_provider VARCHAR(20) NOT NULL DEFAULT 'sykes';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'afa_orders_fulfillment_provider_check'
  ) THEN
    ALTER TABLE afa_orders
      ADD CONSTRAINT afa_orders_fulfillment_provider_check
      CHECK (fulfillment_provider IN ('sykes', 'apexprime'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ussd_afa_orders_fulfillment_provider_check'
  ) THEN
    ALTER TABLE ussd_afa_orders
      ADD CONSTRAINT ussd_afa_orders_fulfillment_provider_check
      CHECK (fulfillment_provider IN ('sykes', 'apexprime'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_afa_orders_provider_pending
  ON afa_orders(fulfillment_provider, fulfillment_status) WHERE fulfillment_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ussd_afa_orders_provider_pending
  ON ussd_afa_orders(fulfillment_provider, fulfillment_status) WHERE fulfillment_status = 'pending';
