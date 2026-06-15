-- Links a WhatsApp number to a Datagod account after the customer proves
-- ownership via an OTP sent to the account's REGISTERED phone. Lets someone who
-- messages the bot from a different number (not their account number) still act
-- on their own account (e.g. auto-credit a stuck wallet top-up). One account per
-- WhatsApp number (unique); re-verifying a different account re-links it.
CREATE TABLE IF NOT EXISTS whatsapp_account_links (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_phone TEXT NOT NULL UNIQUE,                 -- the WhatsApp sender, 233XXXXXXXXX
  user_id        UUID NOT NULL REFERENCES auth.users(id),
  verified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_account_links_user ON whatsapp_account_links(user_id);

ALTER TABLE whatsapp_account_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view whatsapp account links" ON whatsapp_account_links;
CREATE POLICY "Admins can view whatsapp account links"
  ON whatsapp_account_links FOR SELECT
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

DROP POLICY IF EXISTS "Service role full access on whatsapp account links" ON whatsapp_account_links;
CREATE POLICY "Service role full access on whatsapp account links"
  ON whatsapp_account_links FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

GRANT ALL ON whatsapp_account_links TO service_role;
