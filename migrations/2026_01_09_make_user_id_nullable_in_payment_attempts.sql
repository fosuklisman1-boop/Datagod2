-- Make user_id nullable in payment_attempts to support guest checkouts
ALTER TABLE payment_attempts
ALTER COLUMN user_id DROP NOT NULL;
