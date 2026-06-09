-- Add all columns that may be missing depending on which version of the
-- create migration was originally applied.
-- Safe to re-run — every statement uses IF NOT EXISTS.

ALTER TABLE results_check_requests
  ADD COLUMN IF NOT EXISTS result_data text,
  ADD COLUMN IF NOT EXISTS media_url text,
  ADD COLUMN IF NOT EXISTS media_type text,
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS payment_reference text,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'paid',
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'own_voucher',
  ADD COLUMN IF NOT EXISTS voucher_pin text,
  ADD COLUMN IF NOT EXISTS voucher_serial text,
  ADD COLUMN IF NOT EXISTS candidate_type text NOT NULL DEFAULT 'school',
  ADD COLUMN IF NOT EXISTS dob text,
  ADD COLUMN IF NOT EXISTS whatsapp_number text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
