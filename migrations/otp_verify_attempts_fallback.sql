-- DB-backed brute-force fallback for OTP verification.
--
-- The per-attempt caps in /api/auth/verify-phone-otp live in Upstash
-- (applyRateLimit), which FAILS OPEN if Redis is unreachable — so during an
-- Upstash outage the 6-digit code becomes guessable. This adds a Postgres
-- counter that holds regardless of Upstash.
--
-- `attempts` is incremented on every verify try against each still-active code
-- for the phone; once the max exceeds the cap, the API rejects. Counts expire
-- naturally with the codes (10-minute window), so no cleanup job is needed.

ALTER TABLE phone_otp_verifications
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Atomically bump the attempt counter on all live codes for a phone and return
-- the new maximum. Called via RPC by the service role.
CREATE OR REPLACE FUNCTION bump_otp_attempts(p_phone text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_max integer;
BEGIN
  UPDATE phone_otp_verifications
     SET attempts = attempts + 1
   WHERE phone = p_phone
     AND used = false
     AND expires_at > now();

  SELECT COALESCE(MAX(attempts), 0) INTO v_max
    FROM phone_otp_verifications
   WHERE phone = p_phone
     AND used = false
     AND expires_at > now();

  RETURN v_max;
END;
$$;

GRANT EXECUTE ON FUNCTION bump_otp_attempts(text) TO service_role;
