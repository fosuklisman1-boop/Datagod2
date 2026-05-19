-- USSD Shop Orders table
-- Orders placed through the shop-code USSD endpoint.
-- amount = packages.price + shop_packages.profit_margin (retail price charged to customer)
-- shop_price = snapshot of that retail price at order time

CREATE TABLE IF NOT EXISTS ussd_shop_orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_code_id         UUID NOT NULL REFERENCES ussd_shop_codes(id) ON DELETE RESTRICT,
  shop_id              UUID NOT NULL REFERENCES user_shops(id) ON DELETE RESTRICT,
  dialing_phone        VARCHAR(20) NOT NULL,       -- phone that dialed (payer)
  recipient_phone      VARCHAR(20) NOT NULL,       -- phone to receive the bundle
  network              VARCHAR(50) NOT NULL,        -- 'MTN' | 'Telecel' | 'AirtelTigo' | 'AT-iShare'
  paystack_provider    VARCHAR(10) NOT NULL,        -- 'mtn' | 'vod' | 'tgo'
  package_id           UUID REFERENCES packages(id) ON DELETE SET NULL,
  package_size         VARCHAR(50),                -- e.g. '2GB'
  amount               DECIMAL(10,2) NOT NULL,     -- retail price charged to customer
  shop_price           DECIMAL(10,2) NOT NULL,     -- snapshot of packages.price + profit_margin
  paystack_reference   VARCHAR(255) UNIQUE,
  order_status         VARCHAR(50) NOT NULL DEFAULT 'pending',   -- pending | processing | completed | failed
  payment_status       VARCHAR(50) NOT NULL DEFAULT 'pending',   -- pending | otp_required | completed | failed
  session_id           VARCHAR(255),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ussd_shop_orders_paystack_ref   ON ussd_shop_orders(paystack_reference);
CREATE INDEX IF NOT EXISTS idx_ussd_shop_orders_dialing_phone  ON ussd_shop_orders(dialing_phone);
CREATE INDEX IF NOT EXISTS idx_ussd_shop_orders_shop_code_id   ON ussd_shop_orders(shop_code_id);
CREATE INDEX IF NOT EXISTS idx_ussd_shop_orders_shop_id        ON ussd_shop_orders(shop_id);

ALTER TABLE ussd_shop_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on ussd_shop_orders" ON ussd_shop_orders;
CREATE POLICY "Service role full access on ussd_shop_orders"
  ON ussd_shop_orders FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
