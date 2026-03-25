-- ============================================================
-- Airtime Purchase System
-- ============================================================

-- Core table for airtime orders
CREATE TABLE IF NOT EXISTS airtime_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference_code    TEXT NOT NULL UNIQUE,    -- e.g. AT-ABC-123
  network           TEXT NOT NULL,           -- MTN | Telecel | AT
  beneficiary_phone TEXT NOT NULL,
  airtime_amount    NUMERIC(10,2) NOT NULL,  -- what the recipient gets
  fee_amount        NUMERIC(10,2) NOT NULL,  -- platform profit
  total_paid        NUMERIC(10,2) NOT NULL,  -- amount debited from wallet
  pay_separately    BOOLEAN DEFAULT FALSE,   -- true = fee added on top; false = fee deducted from amount
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','failed')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_airtime_orders_user_id   ON airtime_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_airtime_orders_status    ON airtime_orders(status);
CREATE INDEX IF NOT EXISTS idx_airtime_orders_network   ON airtime_orders(network);
CREATE INDEX IF NOT EXISTS idx_airtime_orders_created   ON airtime_orders(created_at DESC);

-- Row Level Security
ALTER TABLE airtime_orders ENABLE ROW LEVEL SECURITY;

-- Users can read their own orders
CREATE POLICY "Users can view own airtime orders"
  ON airtime_orders FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can do everything (used by API routes)
CREATE POLICY "Service role has full access"
  ON airtime_orders FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- Admin Settings seeds (idempotent)
-- ============================================================
INSERT INTO admin_settings (key, value) VALUES
  ('airtime_fee_mtn_customer',    '{"rate": 5}'),
  ('airtime_fee_mtn_agent',       '{"rate": 3}'),
  ('airtime_fee_telecel_customer','{"rate": 5}'),
  ('airtime_fee_telecel_agent',   '{"rate": 3}'),
  ('airtime_fee_at_customer',     '{"rate": 5}'),
  ('airtime_fee_at_agent',        '{"rate": 3}'),
  ('airtime_min_amount',          '{"amount": 1}'),
  ('airtime_max_amount',          '{"amount": 500}'),
  ('airtime_enabled_mtn',         '{"enabled": true}'),
  ('airtime_enabled_telecel',     '{"enabled": true}'),
  ('airtime_enabled_at',          '{"enabled": true}')
ON CONFLICT (key) DO NOTHING;
