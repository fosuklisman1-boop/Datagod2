-- USSD Shop Token Purchases table
-- Records every token top-up (and the one-time activation payment) for a shop code.
-- payment_method: 'wallet' = deducted from shop owner's Datagod wallet
--                 'momo'   = MoMo charge via Paystack (webhook completes it)

CREATE TABLE IF NOT EXISTS ussd_shop_token_purchases (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_code_id         UUID NOT NULL REFERENCES ussd_shop_codes(id) ON DELETE CASCADE,
  shop_id              UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  tokens_purchased     INTEGER NOT NULL,
  amount_paid          DECIMAL(10,2) NOT NULL,
  payment_method       VARCHAR(20) NOT NULL,   -- 'wallet' | 'momo'
  paystack_reference   VARCHAR(255),
  payment_status       VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending' | 'completed' | 'failed'
  is_activation        BOOLEAN NOT NULL DEFAULT false,          -- true = one-time activation payment
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ussd_shop_token_purchases_shop_code_id ON ussd_shop_token_purchases(shop_code_id);
CREATE INDEX IF NOT EXISTS idx_ussd_shop_token_purchases_paystack_ref ON ussd_shop_token_purchases(paystack_reference);

ALTER TABLE ussd_shop_token_purchases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on ussd_shop_token_purchases" ON ussd_shop_token_purchases;
CREATE POLICY "Service role full access on ussd_shop_token_purchases"
  ON ussd_shop_token_purchases FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
