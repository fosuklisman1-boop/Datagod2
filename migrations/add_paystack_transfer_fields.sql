-- Add Paystack transfer tracking columns to withdrawal_requests, mirroring
-- 0042_add_moolre_transfer_fields.sql. Paystack is an admin-selectable
-- alternative to Moolre, chosen per-withdrawal at approval time — these
-- columns only get populated when that withdrawal was routed through Paystack.

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS payout_provider          TEXT NOT NULL DEFAULT 'moolre', -- 'moolre' | 'paystack'
  ADD COLUMN IF NOT EXISTS paystack_recipient_code  TEXT,                           -- Paystack recipient_code (audit only, not reused)
  ADD COLUMN IF NOT EXISTS paystack_transfer_code   TEXT,                           -- needed by POST /transfer/finalize_transfer
  ADD COLUMN IF NOT EXISTS paystack_fee             DECIMAL(10,4);                  -- fee Paystack charged

-- New status value now in use (no CHECK constraint on this column, so this is
-- documentation only, matching how existing statuses are recorded):
--   awaiting_transfer_otp → Paystack /transfer called, status="otp", waiting on
--                           an admin to submit the code via POST
--                           /api/admin/withdrawals/submit-transfer-otp
