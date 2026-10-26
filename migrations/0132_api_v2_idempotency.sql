-- 0132_api_v2_idempotency.sql
--
-- Idempotency claim table for the Developer API v2 commission endpoints
-- (airtime purchase, utility bill payment). v1, the airtime engine
-- (lib/airtime-service.ts) and the bills engine (lib/bills/*) are NOT touched.
--
-- Why: purchaseAirtime takes no client reference and its only duplicate guard
-- is a non-atomic 30-second look-back, so two concurrent identical requests
-- can both reach the debit. v2 therefore CLAIMS the client reference here,
-- atomically, BEFORE the engine is called. The UNIQUE (user_id, kind,
-- reference) constraint is the one thing that stops a retry, a concurrent
-- duplicate or a timeout-and-resend from reaching the engine twice (a double
-- charge). Treat every constraint on this table as money-critical.
--
--   api_v2_idempotency  one row per (user, kind, client reference).
--     kind          'airtime' | 'bill'. The same reference may be used once
--                   per kind (separate endpoints, separate namespaces).
--     reference     the client's reference, 3-100 characters (the route
--                   validates the exact format with parseReference).
--     request_hash  sha256 hex (64 lowercase hex chars) of the canonical
--                   normalised request. Only the hash is stored, never the
--                   request body.
--     status        claim lifecycle (below).
--     order_ref     the engine's order id, set when the claim is done.
--     response      the allow-listed order JSON the API returns for a replay.
--
-- Claim lifecycle:
--   INSERT (status 'in_progress')     written before the engine call. A
--                                     unique_violation means another request
--                                     owns the reference: the route reads that
--                                     row and answers replay / REFERENCE_REUSED
--                                     / REQUEST_IN_PROGRESS / OUTCOME_UNKNOWN,
--                                     and never calls the engine.
--   in_progress -> done               engine success. order_ref and response
--                                     are required (CHECK
--                                     api_v2_idempotency_done_has_order).
--   in_progress -> unknown            ambiguous engine outcome (an error that
--                                     may have charged, or any exception). The
--                                     row is kept and keeps blocking that
--                                     reference; it is surfaced for admin
--                                     reconciliation and never retried
--                                     automatically.
--   in_progress -> (row DELETED)      engine failure with a known NO-CHARGE
--                                     code (validation, gates, insufficient
--                                     balance, price changed, ...). Deleting
--                                     frees the reference so the client can
--                                     retry it after fixing the cause.
--   A claim stuck in 'in_progress' (function killed mid-call) is treated by
--   the route as in progress while fresh and as unknown once older than 10
--   minutes; the partial index on (status, created_at) serves that check and
--   the reconciliation listing.
--
-- Retention and PII: rows are retained until a later prune job (not part of
-- this migration). request_hash is a sha256 only. The recipient number (or
-- bill account) appears ONLY inside response, which holds exactly the
-- allow-listed order object the API already returns to the key owner; no
-- request bodies, verify tokens or provider references are stored.
--
-- FKs:
--   user_id        -> auth.users ON DELETE CASCADE (a removed user's claims go
--                     with them).
--   api_v2_key_id  -> api_v2_keys ON DELETE NO ACTION, not RESTRICT: a key that
--                     has claims cannot be deleted on its own, but NO ACTION is
--                     checked at the end of the statement, so deleting an auth
--                     user (which cascades to both api_v2_keys and this table
--                     in the same statement) is not blocked. Same reasoning as
--                     api_orders.api_v2_key_id in 0130.
--
-- Access: service_role only. RLS enabled with NO policies; all privileges
-- revoked from PUBLIC, anon and authenticated (0060 granted authenticated CRUD
-- on all tables, and Supabase default privileges grant new tables to anon and
-- authenticated, so the revoke is required). Only server routes touch it.
--
-- Idempotent: CREATE ... IF NOT EXISTS and pg_constraint-guarded constraint
-- adds, so a re-run is a no-op. One transaction; the table is new and empty,
-- so every statement is instant.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Table (column-level CHECKs inline; table-level constraints in step 2).
CREATE TABLE IF NOT EXISTS public.api_v2_idempotency (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL
    CONSTRAINT api_v2_idempotency_user_id_fkey
    REFERENCES auth.users(id) ON DELETE CASCADE,
  api_v2_key_id UUID NOT NULL
    CONSTRAINT api_v2_idempotency_api_v2_key_id_fkey
    REFERENCES public.api_v2_keys(id) ON DELETE NO ACTION,
  kind TEXT NOT NULL
    CONSTRAINT api_v2_idempotency_kind_check
    CHECK (kind IN ('airtime', 'bill')),
  reference TEXT NOT NULL
    CONSTRAINT api_v2_idempotency_reference_length_check
    CHECK (char_length(reference) BETWEEN 3 AND 100),
  request_hash TEXT NOT NULL
    CONSTRAINT api_v2_idempotency_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'in_progress'
    CONSTRAINT api_v2_idempotency_status_check
    CHECK (status IN ('in_progress', 'done', 'unknown')),
  order_ref TEXT,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- 2. Table-level constraints, guarded so a re-run is a no-op.
--    The claim itself: one row per (user, kind, reference). All three columns
--    are NOT NULL, so there is no NULLs-are-distinct gap.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_v2_idempotency_user_kind_reference_key'
      AND conrelid = 'public.api_v2_idempotency'::regclass
  ) THEN
    ALTER TABLE public.api_v2_idempotency
      ADD CONSTRAINT api_v2_idempotency_user_kind_reference_key
      UNIQUE (user_id, kind, reference);
  END IF;
END $$;

-- A 'done' claim must carry the order it replays.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_v2_idempotency_done_has_order'
      AND conrelid = 'public.api_v2_idempotency'::regclass
  ) THEN
    ALTER TABLE public.api_v2_idempotency
      ADD CONSTRAINT api_v2_idempotency_done_has_order
      CHECK (status <> 'done' OR (order_ref IS NOT NULL AND response IS NOT NULL));
  END IF;
END $$;

-- 3. Indexes. Lookups by (user, kind, reference) use the unique index above.
--    Owner-scoped "newest first" listing:
CREATE INDEX IF NOT EXISTS api_v2_idempotency_user_kind_created_idx
  ON public.api_v2_idempotency (user_id, kind, created_at DESC);

--    Open (in_progress / unknown) claims for staleness checks and admin
--    reconciliation; done rows are the bulk and are left out.
CREATE INDEX IF NOT EXISTS api_v2_idempotency_open_status_created_idx
  ON public.api_v2_idempotency (status, created_at)
  WHERE status <> 'done';

--    FK index for api_v2_key_id: deleting a key (or an auth user, which
--    cascades to api_v2_keys) checks this table's NO ACTION FK; without an
--    index that check scans the whole table.
CREATE INDEX IF NOT EXISTS api_v2_idempotency_key_idx
  ON public.api_v2_idempotency (api_v2_key_id);

-- 4. Lock to service_role only.
ALTER TABLE public.api_v2_idempotency ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_v2_idempotency FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_v2_idempotency TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT conname, contype, confdeltype FROM pg_constraint
--    WHERE conrelid = 'public.api_v2_idempotency'::regclass ORDER BY conname;
--      -- user_id_fkey confdeltype 'c', api_v2_key_id_fkey 'a', plus the
--      -- unique key, done_has_order and the four column CHECKs
--   SELECT indexname FROM pg_indexes WHERE tablename = 'api_v2_idempotency';
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.api_v2_idempotency'::regclass;  -- true
--   SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'api_v2_idempotency';  -- 0
--   SELECT has_table_privilege('anon', 'public.api_v2_idempotency', 'SELECT'),
--          has_table_privilege('authenticated', 'public.api_v2_idempotency', 'SELECT');  -- both false
-- Self-test (self-rolling-back dry run): migrations/0132_api_v2_idempotency.selftest.sql
