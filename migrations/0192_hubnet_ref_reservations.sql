-- 0192_hubnet_ref_reservations.sql
--
-- Hubnet reference reservations. NOT applied by the implementing agent. One transaction. Idempotent.
--
-- Hubnet was proven live NOT to reject a reused reference, so we reserve each reference in our own DB BEFORE calling
-- Hubnet. The primary key makes the reservation atomic: the second INSERT of the same ref fails with 23505 (held).
-- Service-role only: RLS on with no policies, everything revoked from PUBLIC/anon/authenticated.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS hubnet_ref_reservations (
  ref        text        PRIMARY KEY CHECK (length(btrim(ref)) > 0),
  kind       text        NOT NULL CHECK (kind IN ('data', 'airtime')),
  order_id   text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE hubnet_ref_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubnet_ref_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON hubnet_ref_reservations TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT has_table_privilege('anon', 'public.hubnet_ref_reservations', 'SELECT'),
--          has_table_privilege('authenticated', 'public.hubnet_ref_reservations', 'INSERT'),
--          has_table_privilege('service_role', 'public.hubnet_ref_reservations', 'INSERT');   -- false, false, true
