-- Add network-specific price adjustment percentage columns to app_settings table
-- Positive values = markup (increase price), Negative values = discount (decrease price)
-- Example: 10 means +10% (prices increase), -5 means -5% (prices decrease)

ALTER TABLE app_settings 
ADD COLUMN IF NOT EXISTS price_adjustment_mtn DECIMAL(5,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS price_adjustment_telecel DECIMAL(5,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS price_adjustment_at_ishare DECIMAL(5,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS price_adjustment_at_bigtime DECIMAL(5,2) DEFAULT 0;

-- Add comments for documentation
COMMENT ON COLUMN app_settings.price_adjustment_mtn IS 'Price adjustment percentage for MTN packages (-100 to +100)';
COMMENT ON COLUMN app_settings.price_adjustment_telecel IS 'Price adjustment percentage for Telecel packages (-100 to +100)';
COMMENT ON COLUMN app_settings.price_adjustment_at_ishare IS 'Price adjustment percentage for AT-iShare packages (-100 to +100)';
COMMENT ON COLUMN app_settings.price_adjustment_at_bigtime IS 'Price adjustment percentage for AT-BigTime packages (-100 to +100)';
