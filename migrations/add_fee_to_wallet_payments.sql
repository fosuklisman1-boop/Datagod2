-- Add fee column to wallet_payments table to track Paystack fees
ALTER TABLE wallet_payments
ADD COLUMN fee DECIMAL(10, 2) DEFAULT 0;

-- Add comment for clarity
COMMENT ON COLUMN wallet_payments.fee IS 'Paystack transaction fee (3% of amount)';
