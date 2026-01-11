-- Add profit balance tracking columns to shop_profits table
-- This tracks the user's profit balance before and after each profit transaction

ALTER TABLE shop_profits ADD COLUMN IF NOT EXISTS profit_balance_before DECIMAL(10, 2);
ALTER TABLE shop_profits ADD COLUMN IF NOT EXISTS profit_balance_after DECIMAL(10, 2);

-- Create index for better query performance on balance columns
CREATE INDEX IF NOT EXISTS idx_shop_profits_balance_after ON shop_profits(profit_balance_after);

COMMENT ON COLUMN shop_profits.profit_balance_before IS 'User profit balance before this profit was added';
COMMENT ON COLUMN shop_profits.profit_balance_after IS 'User profit balance after this profit was added';
