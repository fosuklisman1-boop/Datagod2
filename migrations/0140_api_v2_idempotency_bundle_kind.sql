-- 0140_api_v2_idempotency_bundle_kind.sql
--
-- Widens the claim kind of api_v2_idempotency (0132, widened by 0138 and 0139) from
-- ('airtime', 'bill', 'results', 'afa', 'sms') to
-- ('airtime', 'bill', 'results', 'afa', 'sms', 'bundle')
-- so the Developer API v2 Standard Bundles purchase endpoint can claim a client
-- reference atomically BEFORE it debits the wallet, exactly like the other
-- endpoints do. The UNIQUE (user_id, kind, reference) constraint is unchanged:
-- the same reference may still be used once per kind.
--
-- Only the CHECK api_v2_idempotency_kind_check is replaced. No data change;
-- the existing rows all satisfy the wider check, so adding it cannot fail on
-- existing data.
--
-- Idempotent: the old check is dropped and the new one added only when the
-- current definition does not already list 'bundle', so a re-run is a no-op.
-- One transaction; DROP + ADD happen inside it, so no insert can slip through
-- unchecked between them.
--
-- Self-test (self-rolling-back dry run): migrations/0140_api_v2_idempotency_bundle_kind.selftest.sql
-- That run string must be built by CODE which asserts it contains no COMMIT
-- and no bare END; statement (the 0130 incident lesson); see the selftest header.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conname = 'api_v2_idempotency_kind_check'
    AND conrelid = 'public.api_v2_idempotency'::regclass;

  IF v_def IS NULL OR v_def NOT LIKE '%''bundle''%' THEN
    ALTER TABLE public.api_v2_idempotency
      DROP CONSTRAINT IF EXISTS api_v2_idempotency_kind_check;
    ALTER TABLE public.api_v2_idempotency
      ADD CONSTRAINT api_v2_idempotency_kind_check
      CHECK (kind IN ('airtime', 'bill', 'results', 'afa', 'sms', 'bundle'));
  END IF;
END $$;

COMMIT;

-- Verify after apply (read-only):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'api_v2_idempotency_kind_check'
--      AND conrelid = 'public.api_v2_idempotency'::regclass;
--      -- CHECK (kind = ANY (ARRAY['airtime'::text, 'bill'::text, 'results'::text, 'afa'::text, 'sms'::text, 'bundle'::text]))
--   SELECT kind, count(*) FROM public.api_v2_idempotency GROUP BY kind;
