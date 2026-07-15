-- Manual USSD whitelist: admin-uploaded phone numbers that bypass the
-- "has completed order" gate when ussd_data_whitelist_enabled is ON.
CREATE TABLE IF NOT EXISTS ussd_whitelist (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ussd_whitelist ENABLE ROW LEVEL SECURITY;

-- Service role has full access; no anon/authenticated access needed
CREATE POLICY "service role only" ON ussd_whitelist
  USING (true)
  WITH CHECK (true);

-- Fast lookup by phone number (the USSD router query pattern)
CREATE INDEX IF NOT EXISTS ussd_whitelist_phone_idx ON ussd_whitelist (phone_number);
