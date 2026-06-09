-- Results Check Requests: stores requests from users who paid to have
-- the admin check their exam results on their behalf.

CREATE TABLE IF NOT EXISTS results_check_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text NOT NULL,
  exam_board text NOT NULL,                 -- 'WAEC' | 'BECE' | 'NOVDEC'
  index_number text NOT NULL,
  exam_year integer NOT NULL,
  fee numeric(10,2) NOT NULL DEFAULT 2.00,
  payment_status text NOT NULL DEFAULT 'paid',   -- 'paid' | 'refunded'
  status text NOT NULL DEFAULT 'pending',         -- 'pending' | 'checking' | 'completed' | 'failed'
  result_data text,                               -- result text entered by admin
  media_url text,                                 -- optional media URL (image/document) to send with results
  media_type text,                                -- 'image' | 'document' | 'video'
  channel text NOT NULL DEFAULT 'whatsapp',       -- 'whatsapp' | 'ussd'
  mode text NOT NULL DEFAULT 'own_voucher',        -- 'combo' | 'own_voucher'
  voucher_pin text,                                -- PIN the user provided or was assigned (combo)
  voucher_serial text,                             -- serial number of the assigned voucher (combo only)
  user_id uuid,
  payment_reference text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_results_check_requests_phone ON results_check_requests (phone_number);
CREATE INDEX IF NOT EXISTS idx_results_check_requests_status ON results_check_requests (status);
CREATE INDEX IF NOT EXISTS idx_results_check_requests_created ON results_check_requests (created_at DESC);

ALTER TABLE results_check_requests ENABLE ROW LEVEL SECURITY;

-- Admin and service role can do everything; users see only their own
CREATE POLICY "admin_full_access_results_check_requests"
  ON results_check_requests FOR ALL
  USING (true);

-- Seed default settings for the check service
INSERT INTO admin_settings (key, value, description)
VALUES (
  'results_check_settings',
  '{"enabled": true, "fee": 2.00}'::jsonb,
  'Results Check service settings: enabled toggle and fee per check'
)
ON CONFLICT (key) DO NOTHING;
