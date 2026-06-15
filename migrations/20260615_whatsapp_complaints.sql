-- Lightweight complaints filed via the WhatsApp bot. Unlike the order-dispute
-- `complaints` table (login + order + evidence images), this works for guests:
-- just a phone number + free-text description. Admins (the Results Check admin
-- WhatsApp numbers) claim and resolve from WhatsApp, mirroring results_check_requests.
CREATE TABLE IF NOT EXISTS whatsapp_complaints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  TEXT NOT NULL,                 -- customer, 233XXXXXXXXX
  customer_name TEXT,
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | claimed | resolved | cancelled
  claimed_by    TEXT,                           -- admin local number 0XXXXXXXXX
  claimed_at    TIMESTAMPTZ,
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT,                           -- the reply sent to the customer
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_complaints_status ON whatsapp_complaints(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_complaints_phone ON whatsapp_complaints(phone_number);

ALTER TABLE whatsapp_complaints ENABLE ROW LEVEL SECURITY;

-- Admins can read in the dashboard; all writes go through the service-role API.
DROP POLICY IF EXISTS "Admins can view whatsapp complaints" ON whatsapp_complaints;
CREATE POLICY "Admins can view whatsapp complaints"
  ON whatsapp_complaints FOR SELECT
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'));

DROP POLICY IF EXISTS "Service role full access on whatsapp complaints" ON whatsapp_complaints;
CREATE POLICY "Service role full access on whatsapp complaints"
  ON whatsapp_complaints FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

GRANT ALL ON whatsapp_complaints TO service_role;
-- No grant to `authenticated`: all reads/writes go through service-role API
-- routes. Keeping the table off the authenticated role removes a latent PII
-- exposure path even though the admin SELECT policy already gates rows.
