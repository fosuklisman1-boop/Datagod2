-- Two tables for phone number bulk verification.
-- All access via service role key (admin-only).

CREATE TABLE IF NOT EXISTS phone_verification_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name       TEXT NOT NULL,
  total_count     INT NOT NULL DEFAULT 0,
  verified_count  INT NOT NULL DEFAULT 0,
  invalid_count   INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'processing',  -- processing | completed | failed
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS phone_verification_results (
  id              BIGSERIAL PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES phone_verification_sessions(id) ON DELETE CASCADE,
  phone_number    TEXT NOT NULL,
  account_name    TEXT,          -- null if invalid / no name returned
  network         TEXT NOT NULL, -- MTN | TELECEL | AT | UNKNOWN
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | verified | invalid
  verified_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pvr_session_id     ON phone_verification_results(session_id);
CREATE INDEX IF NOT EXISTS idx_pvr_session_status ON phone_verification_results(session_id, status);
