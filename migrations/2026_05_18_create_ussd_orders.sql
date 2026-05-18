-- USSD Orders table
-- Stores orders initiated through the USSD self-service storefront.
-- Payment is collected via Paystack mobile money charge to the dialing number.

CREATE TABLE IF NOT EXISTS ussd_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dialing_phone       VARCHAR(20) NOT NULL,       -- phone that dialed USSD (also pays)
  recipient_phone     VARCHAR(20) NOT NULL,       -- phone to receive the data bundle
  network             VARCHAR(50) NOT NULL,        -- 'MTN' | 'Telecel' | 'AirtelTigo' | 'AT-iShare'
  paystack_provider   VARCHAR(10) NOT NULL,        -- 'mtn' | 'vod' | 'atl'
  package_id          UUID REFERENCES packages(id) ON DELETE SET NULL,
  package_size        VARCHAR(50),                 -- e.g. '2GB'
  amount              DECIMAL(10,2) NOT NULL,      -- GHS charged to dialing number
  price_tier          VARCHAR(20) NOT NULL DEFAULT 'regular', -- 'regular' | 'dealer' (snapshot at order time)
  paystack_reference  VARCHAR(255) UNIQUE,         -- set after Paystack charge is initiated
  order_status        VARCHAR(50) NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed
  payment_status      VARCHAR(50) NOT NULL DEFAULT 'pending',  -- pending | completed | failed
  session_id          VARCHAR(255),                -- Uzo session ID for traceability
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for webhook lookup by Paystack reference
CREATE INDEX IF NOT EXISTS idx_ussd_orders_paystack_ref ON ussd_orders(paystack_reference);

-- Index for phone-based lookups (order status queries via USSD)
CREATE INDEX IF NOT EXISTS idx_ussd_orders_dialing_phone ON ussd_orders(dialing_phone);

-- RLS: service role only (no user-facing RLS needed; USSD endpoint uses service role key)
ALTER TABLE ussd_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on ussd_orders"
  ON ussd_orders FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
