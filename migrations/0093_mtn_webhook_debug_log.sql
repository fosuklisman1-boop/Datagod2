-- Temporary diagnostic table: capture every inbound MTN webhook delivery raw,
-- regardless of signature/parse outcome, so we can see exactly what a provider
-- sends when our assumed payload shape doesn't match reality.
CREATE TABLE IF NOT EXISTS mtn_webhook_debug_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  headers jsonb,
  raw_body text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mtn_webhook_debug_log_provider_idx
  ON mtn_webhook_debug_log (provider, created_at DESC);
