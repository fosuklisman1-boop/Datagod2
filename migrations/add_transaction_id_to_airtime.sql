-- Migration: Add transaction_id to airtime_orders to track Paystack/Payment Gateway IDs
ALTER TABLE airtime_orders ADD COLUMN IF NOT EXISTS transaction_id TEXT;

-- Index for searching by transaction ID
CREATE INDEX IF NOT EXISTS idx_airtime_orders_transaction_id ON airtime_orders(transaction_id);
