-- OTP codes for phone number verification during signup
CREATE TABLE IF NOT EXISTS phone_otp_verifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       VARCHAR(20) NOT NULL,
  code        VARCHAR(6)  NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phone_otp_phone    ON phone_otp_verifications(phone);
CREATE INDEX IF NOT EXISTS idx_phone_otp_expires  ON phone_otp_verifications(expires_at);

-- Only service role may read/write this table (no user-facing RLS policies)
ALTER TABLE phone_otp_verifications ENABLE ROW LEVEL SECURITY;
