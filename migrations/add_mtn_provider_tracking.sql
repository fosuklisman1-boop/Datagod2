-- Add provider column to mtn_fulfillment_tracking table
-- This tracks which provider was used for each order

ALTER TABLE mtn_fulfillment_tracking ADD COLUMN IF NOT EXISTS provider VARCHAR(50);

-- Backfill existing records with 'sykes' (they were all created with Sykes)
UPDATE mtn_fulfillment_tracking 
SET provider = 'sykes' 
WHERE provider IS NULL;

-- Add index for faster provider filtering
CREATE INDEX IF NOT EXISTS idx_mtn_fulfillment_tracking_provider 
ON mtn_fulfillment_tracking(provider);

-- Insert default provider selection setting (Sykes as default)
INSERT INTO admin_settings (key, value, updated_at)
VALUES (
  'mtn_provider_selection',
  '{"provider": "sykes"}'::jsonb,
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Add comment for documentation
COMMENT ON COLUMN mtn_fulfillment_tracking.provider IS 'MTN provider used for this order (sykes, datakazina)';
