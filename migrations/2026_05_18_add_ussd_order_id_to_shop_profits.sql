-- Allow shop_profits to track USSD sub-agent orders.
-- Same pattern as airtime_order_id and results_checker_order_id.
ALTER TABLE shop_profits
  ADD COLUMN IF NOT EXISTS ussd_order_id UUID
    REFERENCES ussd_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sp_ussd_order
  ON shop_profits(ussd_order_id)
  WHERE ussd_order_id IS NOT NULL;
