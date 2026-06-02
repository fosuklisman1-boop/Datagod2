-- Track whether a user's phone number has been verified via OTP.
-- Existing users default to FALSE; new signups set TRUE during profile creation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;
