-- Add missing columns to app_settings table
-- This migration adds support for announcement settings and configurable payment fees

ALTER TABLE app_settings 
ADD COLUMN IF NOT EXISTS announcement_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS announcement_title VARCHAR(255),
ADD COLUMN IF NOT EXISTS announcement_message TEXT,
ADD COLUMN IF NOT EXISTS paystack_fee_percentage DECIMAL(5,2) DEFAULT 3.0,
ADD COLUMN IF NOT EXISTS wallet_topup_fee_percentage DECIMAL(5,2) DEFAULT 0.0,
ADD COLUMN IF NOT EXISTS withdrawal_fee_percentage DECIMAL(5,2) DEFAULT 0.0;

-- Add columns to withdrawal_requests table for fee tracking
ALTER TABLE withdrawal_requests
ADD COLUMN IF NOT EXISTS fee_amount DECIMAL(10,2) DEFAULT 0.0,
ADD COLUMN IF NOT EXISTS net_amount DECIMAL(10,2);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_app_settings_created_at ON app_settings(created_at);

-- Add comment for fee columns
COMMENT ON COLUMN app_settings.paystack_fee_percentage IS 'Fee percentage charged for Paystack payments (e.g., 3.0 for 3%)';
COMMENT ON COLUMN app_settings.wallet_topup_fee_percentage IS 'Fee percentage charged for wallet top-ups (e.g., 2.5 for 2.5%)';
COMMENT ON COLUMN app_settings.withdrawal_fee_percentage IS 'Fee percentage charged for withdrawals (e.g., 5.0 for 5%)';
COMMENT ON COLUMN withdrawal_requests.fee_amount IS 'Fee amount deducted from the withdrawal request';
COMMENT ON COLUMN withdrawal_requests.net_amount IS 'Amount actually paid to shop owner after fee deduction';
