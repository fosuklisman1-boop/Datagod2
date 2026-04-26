-- Extend shop_profits with nullable FK for results checker orders.
-- Same pattern as airtime_order_id column already in the table.
ALTER TABLE shop_profits
  ADD COLUMN IF NOT EXISTS results_checker_order_id UUID
    REFERENCES results_checker_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sp_rc_order
  ON shop_profits(results_checker_order_id)
  WHERE results_checker_order_id IS NOT NULL;
