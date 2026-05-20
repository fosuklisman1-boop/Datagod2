-- Add Moolre transfer tracking columns to withdrawal_requests.
-- These columns store the state from Moolre's transfer API so we can
-- poll for completion and audit every transfer attempt.

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS moolre_transfer_id   TEXT,          -- Moolre transactionid returned on initiate
  ADD COLUMN IF NOT EXISTS moolre_external_ref  TEXT,          -- externalref sent (= withdrawal request UUID)
  ADD COLUMN IF NOT EXISTS moolre_fee           DECIMAL(10,4), -- amountfee charged by Moolre
  ADD COLUMN IF NOT EXISTS transfer_attempted_at TIMESTAMPTZ,  -- when we called /transfer
  ADD COLUMN IF NOT EXISTS transfer_completed_at TIMESTAMPTZ;  -- when txstatus resolved to 1

-- Status values now in use:
--   pending     → submitted by user, waiting for admin approval
--   processing  → Moolre /transfer called, txstatus=0 (MoMo prompt pending)
--   completed   → Moolre txstatus=1 confirmed, funds delivered, balance deducted
--   failed      → Moolre txstatus=2, funds NOT sent, balance NOT deducted
--   rejected    → admin rejected before any transfer attempt
--   cancelled   → user cancelled their own pending request
