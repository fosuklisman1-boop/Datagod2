-- Lets an admin pick a subset of whitelist-capable providers
-- (xpress/codecraft/agentportalgh) for a bulk MTN whitelist check, instead
-- of always checking every configured one.
--
-- whitelist_providers records which providers a given phone_verification
-- session was configured to use (null for moolre sessions).
--
-- whitelist_checked_providers is the cumulative union, across every write
-- from either entry point (the phone-verify upload flow and the
-- mtn-whitelist/batch-verify bulk tool), of every provider ever consulted
-- to produce a number's current whitelist_status. This is new information —
-- previously only "who allowed it" (whitelist_allowed_by) was tracked, never
-- "who was asked and said no." It's what makes dedupe provider-selection-
-- aware: a stored "blocked" result only counts as "known" for a given run if
-- every provider that run would ask has already been tried.
ALTER TABLE phone_verification_sessions
  ADD COLUMN IF NOT EXISTS whitelist_providers TEXT[];

ALTER TABLE mtn_number_registry
  ADD COLUMN IF NOT EXISTS whitelist_checked_providers TEXT[] NOT NULL DEFAULT '{}';
