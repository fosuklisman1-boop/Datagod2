-- Multi-admin WhatsApp notify & delivery for Results Check Service
ALTER TABLE results_check_requests
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_results_check_requests_claimed ON results_check_requests(claimed_by);

INSERT INTO admin_settings (key, value, description)
VALUES (
  'results_check_admin_phones',
  '{"phones": []}'::jsonb,
  'Ghana numbers (0XXXXXXXXX) of admins notified on WhatsApp for new Results Check requests; can claim & deliver via WhatsApp'
)
ON CONFLICT (key) DO NOTHING;
