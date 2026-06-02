-- Add purpose column to distinguish OTP use cases (signup vs checkout vs other)
ALTER TABLE phone_otp_verifications
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(30) NOT NULL DEFAULT 'signup';

CREATE INDEX IF NOT EXISTS idx_phone_otp_purpose ON phone_otp_verifications(phone, purpose);
