-- Grace period deadline for phone verification.
-- Users have 2 days from when this migration runs to verify before actions are restricted.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verify_deadline TIMESTAMPTZ;

UPDATE users
SET phone_verify_deadline = NOW() + INTERVAL '2 days'
WHERE (phone_verified = FALSE OR phone_verified IS NULL)
  AND phone_verify_deadline IS NULL;
