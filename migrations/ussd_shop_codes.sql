-- USSD Shop Codes table
-- Each shop gets a unique short numeric PIN (shop code).
-- Customers dial the separate USSD endpoint and enter the code to access that shop's catalog.
-- Every customer session that enters a code costs the shop one token (token_balance).

CREATE TABLE IF NOT EXISTS ussd_shop_codes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id               UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  code                  VARCHAR(8) NOT NULL UNIQUE,         -- short numeric PIN e.g. "1234"
  status                VARCHAR(20) NOT NULL DEFAULT 'inactive',  -- 'inactive' | 'active' | 'suspended'
  token_balance         INTEGER NOT NULL DEFAULT 0,          -- sessions remaining
  activation_fee_paid   BOOLEAN NOT NULL DEFAULT false,
  activation_paid_at    TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ussd_shop_codes_code     ON ussd_shop_codes(code);
CREATE INDEX IF NOT EXISTS idx_ussd_shop_codes_shop_id  ON ussd_shop_codes(shop_id);
CREATE INDEX IF NOT EXISTS idx_ussd_shop_codes_status   ON ussd_shop_codes(status);

ALTER TABLE ussd_shop_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on ussd_shop_codes" ON ussd_shop_codes;
CREATE POLICY "Service role full access on ussd_shop_codes"
  ON ussd_shop_codes FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
