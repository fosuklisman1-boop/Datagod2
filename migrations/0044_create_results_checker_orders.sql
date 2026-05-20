CREATE TABLE IF NOT EXISTS results_checker_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL for guest purchases
  reference_code TEXT NOT NULL UNIQUE,                        -- RC-XXX-XXX
  exam_board TEXT NOT NULL CHECK (exam_board IN ('WAEC', 'BECE', 'NOVDEC')),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),

  -- Customer info (populated for guest purchases; may duplicate for logged-in users)
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,

  -- Pricing (flat model: unit_price = base_price + markup_per_voucher)
  unit_price NUMERIC(10,2) NOT NULL,            -- what customer pays per voucher
  fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0,  -- platform fee (currently 0)
  total_paid NUMERIC(10,2) NOT NULL,            -- unit_price * quantity + fee_amount
  shop_id UUID REFERENCES user_shops(id) ON DELETE SET NULL,
  merchant_commission NUMERIC(10,2) DEFAULT 0,  -- markup_per_voucher * quantity

  -- Dual status mirrors airtime_orders pattern
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'pending_payment', 'completed', 'failed')),
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'pending_payment', 'completed', 'failed')),

  -- Assigned voucher inventory rows (populated after payment confirmed)
  inventory_ids UUID[],

  -- Delivery tracking
  delivered_via TEXT[],  -- e.g. ['screen', 'sms', 'email']

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rco_user    ON results_checker_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_rco_ref     ON results_checker_orders(reference_code);
CREATE INDEX IF NOT EXISTS idx_rco_status  ON results_checker_orders(status);
CREATE INDEX IF NOT EXISTS idx_rco_shop    ON results_checker_orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_rco_created ON results_checker_orders(created_at DESC);

ALTER TABLE results_checker_orders ENABLE ROW LEVEL SECURITY;

-- Users can read their own orders; service_role has full access
CREATE POLICY "rco_users_own"
  ON results_checker_orders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "rco_service_role_full"
  ON results_checker_orders FOR ALL TO service_role USING (true);
