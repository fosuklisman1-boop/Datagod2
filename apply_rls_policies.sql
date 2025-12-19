-- Apply missing RLS policies for shop_customers and customer_tracking
-- This allows the system (service role) to insert and update customer records

-- RLS Policy: System can insert shop customers (for tracking)
DROP POLICY IF EXISTS "System can insert shop customers" ON shop_customers;
CREATE POLICY "System can insert shop customers"
  ON shop_customers FOR INSERT
  WITH CHECK (true);

-- RLS Policy: System can update shop customers (for tracking)
DROP POLICY IF EXISTS "System can update shop customers" ON shop_customers;
CREATE POLICY "System can update shop customers"
  ON shop_customers FOR UPDATE
  USING (true);

-- RLS Policy: System can insert customer tracking records
DROP POLICY IF EXISTS "System can insert customer tracking" ON customer_tracking;
CREATE POLICY "System can insert customer tracking"
  ON customer_tracking FOR INSERT
  WITH CHECK (true);
