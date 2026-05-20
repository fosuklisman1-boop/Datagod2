-- RLS policies for ussd_shop_orders
-- Allows shop owners to read their own orders and admins to read all.

ALTER TABLE ussd_shop_orders ENABLE ROW LEVEL SECURITY;

-- Shop owners can read orders for their own shop
CREATE POLICY "shop_owners_can_read_ussd_shop_orders"
ON ussd_shop_orders FOR SELECT
TO authenticated
USING (
  shop_id IN (
    SELECT id FROM user_shops WHERE user_id = auth.uid()
  )
);

-- Admins can read all orders
CREATE POLICY "admins_can_read_all_ussd_shop_orders"
ON ussd_shop_orders FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'
  )
);

-- Service role bypasses RLS automatically (no policy needed for API routes).
