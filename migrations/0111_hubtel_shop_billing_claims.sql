-- 0111_hubtel_shop_billing_claims.sql
-- Shop-mode token billing guard for the Hubtel USSD channel: at most ONE shop session token per
-- (Hubtel SessionId, shop code). Replaces the Redis SET NX marker so a Redis outage no longer turns
-- every shop code into "Shop unavailable". The primary key is the guard: a second insert for the
-- same pair fails with 23505 and the caller treats it as "already paid".
--
-- MUST be applied before the deploy that reads it: until then every claim errors and shop codes
-- are refused with "Shop unavailable" (never deducted unguarded). Rows are only needed for the life
-- of a Hubtel session; anything older than a day can be deleted at any time.

CREATE TABLE IF NOT EXISTS hubtel_shop_billing_claims (
  session_id    text NOT NULL,
  shop_code_id  uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, shop_code_id)
);

CREATE INDEX IF NOT EXISTS idx_hubtel_shop_billing_claims_created_at ON hubtel_shop_billing_claims (created_at);

ALTER TABLE hubtel_shop_billing_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_shop_billing_claims FROM anon, authenticated;
