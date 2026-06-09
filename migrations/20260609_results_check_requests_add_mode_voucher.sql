-- Add mode and voucher columns to results_check_requests
-- Run this if you already applied 20260609_create_results_check_requests.sql

ALTER TABLE results_check_requests
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'own_voucher',
  ADD COLUMN IF NOT EXISTS voucher_pin text,
  ADD COLUMN IF NOT EXISTS voucher_serial text;
