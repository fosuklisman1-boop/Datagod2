-- Adds MTN-whitelist check support to the existing phone-verification tables.
-- check_type distinguishes a Moolre account-name session from an MTN
-- whitelist-eligibility session (both share the same results table).
-- not_applicable_count tracks numbers skipped in whitelist mode because they
-- aren't MTN (or the network couldn't be determined) — kept as its own
-- column, mirroring verified_count/invalid_count, so "duplicate" can still be
-- derived by subtraction without conflating it with "not applicable."
-- whitelist_provider records which provider (xpress|codecraft|agentportalgh)
-- allowed a number in a whitelist session; stays null for Moolre rows and for
-- blocked/not-applicable whitelist rows.
ALTER TABLE phone_verification_sessions
  ADD COLUMN IF NOT EXISTS check_type TEXT NOT NULL DEFAULT 'moolre'
    CHECK (check_type IN ('moolre', 'mtn_whitelist')),
  ADD COLUMN IF NOT EXISTS not_applicable_count INT NOT NULL DEFAULT 0;

ALTER TABLE phone_verification_results
  ADD COLUMN IF NOT EXISTS whitelist_provider TEXT;
