-- Migration: Add notes and type to shop_profits for manual adjustments
-- This allows admins to explain manual credits/debits

ALTER TABLE shop_profits ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE shop_profits ADD COLUMN IF NOT EXISTS adjustment_type VARCHAR(50); -- e.g. 'manual', 'order', 'airtime'

COMMENT ON COLUMN shop_profits.notes IS 'Reason for manual adjustment or special notes.';
COMMENT ON COLUMN shop_profits.adjustment_type IS 'Category of profit entry: manual, order, airtime.';
