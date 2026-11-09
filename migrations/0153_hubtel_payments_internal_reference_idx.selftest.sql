-- 0153_hubtel_payments_internal_reference_idx.selftest.sql
--
-- NOT A MIGRATION. Local PGlite selftest (psql-only, no real database touched). Run from the repo root with a
-- runner that expands `\i` (see memory reference-pglite-sql-tests). PASSES when it prints 'SELFTEST_OK'.
--
-- Scenarios: the index exists, is plain (not unique, not partial) and is on internal_reference only; failed/paid rows
-- sharing a reference still insert; the open-attempt unique index still refuses a second open row; idempotent re-run.

DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $r$;

\i migrations/0151_hubtel_payments.sql
\i migrations/0153_hubtel_payments_internal_reference_idx.sql
-- Re-run: must be idempotent.
\i migrations/0153_hubtel_payments_internal_reference_idx.sql

DO $selftest$
DECLARE
  v_def text;
  v_dup boolean := false;
BEGIN
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'hubtel_payments' AND indexname = 'hubtel_payments_internal_reference_idx';
  IF v_def IS NULL THEN RAISE EXCEPTION 'FAIL missing: index not created'; END IF;
  IF v_def ILIKE '%UNIQUE%' THEN RAISE EXCEPTION 'FAIL unique: %', v_def; END IF;
  IF v_def ILIKE '%WHERE%' THEN RAISE EXCEPTION 'FAIL partial: %', v_def; END IF;
  IF v_def NOT ILIKE '%(internal_reference)%' THEN RAISE EXCEPTION 'FAIL column: %', v_def; END IF;

  -- Closed rows may share a reference.
  INSERT INTO public.hubtel_payments (reference, internal_reference, surface, mode, amount_pesewas, status, expires_at) VALUES
    ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'R1', 'wallet_topup', 'direct', 100, 'failed', now()),
    ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'R1', 'wallet_topup', 'direct', 100, 'paid', now()),
    ('cccccccccccccccccccccccccccccccc', 'R1', 'wallet_topup', 'direct', 100, 'pending', now());
  BEGIN
    INSERT INTO public.hubtel_payments (reference, internal_reference, surface, mode, amount_pesewas, status, expires_at) VALUES
      ('dddddddddddddddddddddddddddddddd', 'R1', 'wallet_topup', 'direct', 100, 'pending', now());
  EXCEPTION WHEN unique_violation THEN
    v_dup := true;
  END;
  IF NOT v_dup THEN RAISE EXCEPTION 'FAIL open_index: a second open attempt was accepted'; END IF;

  RAISE NOTICE 'SELFTEST_OK';
END
$selftest$;
