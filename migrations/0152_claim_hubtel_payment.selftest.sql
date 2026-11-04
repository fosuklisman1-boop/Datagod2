-- 0152_claim_hubtel_payment.selftest.sql
--
-- NOT A MIGRATION. Local PGlite selftest (psql-only, no real database touched). Run from the repo root with a
-- runner that expands `\i` (see memory reference-pglite-sql-tests). PASSES when it prints 'SELFTEST_OK'; any
-- 'FAIL ...' notice/error means it failed.
--
-- Scenarios: function exists; only service_role may execute (anon/authenticated cannot); SECURITY DEFINER; a
-- pending row is claimed once (second claim returns no row — the same WHERE that a concurrent UPDATE re-checks
-- under the row lock); claim sets status/claimed_at/updated_at; a confirming row claimed 9 min ago is NOT
-- reclaimed, 11 min ago IS; paid/failed/needs_review rows are never claimed; unknown reference returns no row;
-- idempotent re-run.
--
-- PGlite is a single connection, so true parallelism cannot be exercised here. The exactly-once guarantee rests on
-- the claim being ONE `UPDATE ... WHERE status = 'pending' ... RETURNING`: in Postgres (READ COMMITTED) a second
-- concurrent UPDATE blocks on the row lock, then re-evaluates the WHERE against the committed row
-- (status = 'confirming', fresh claimed_at) and matches nothing. The sequential double-claim below asserts the
-- predicate that makes that re-check fail.

DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $r$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;

\i migrations/0151_hubtel_payments.sql
\i migrations/0152_claim_hubtel_payment.sql
-- Re-run: must be idempotent.
\i migrations/0152_claim_hubtel_payment.sql

DO $selftest$
DECLARE
  v_r   text;
  v_n   integer;
  v_row public.hubtel_payments%ROWTYPE;
  A     constant text := 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  B9    constant text := 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  C11   constant text := 'cccccccccccccccccccccccccccccccc';
  P     constant text := 'dddddddddddddddddddddddddddddddd';
  F     constant text := 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  R     constant text := 'ffffffffffffffffffffffffffffffff';
BEGIN
  IF to_regprocedure('public.claim_hubtel_payment(text)') IS NULL THEN
    RAISE EXCEPTION 'FAIL function_exists: claim_hubtel_payment(text) missing';
  END IF;

  FOREACH v_r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF has_function_privilege(v_r, 'public.claim_hubtel_payment(text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL grants: % may execute claim_hubtel_payment', v_r;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.claim_hubtel_payment(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL grants: service_role cannot execute claim_hubtel_payment';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.claim_hubtel_payment(text)'::regprocedure) THEN
    RAISE EXCEPTION 'FAIL security_definer: claim_hubtel_payment is not SECURITY DEFINER';
  END IF;

  INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at, updated_at)
    VALUES (A, 'wallet', 'checkout', 2000, now() + interval '30 minutes', now() - interval '1 hour');
  INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, status, claimed_at, expires_at)
    VALUES (B9,  'wallet', 'checkout', 2000, 'confirming',   now() - interval '9 minutes',  now() + interval '30 minutes'),
           (C11, 'wallet', 'checkout', 2000, 'confirming',   now() - interval '11 minutes', now() + interval '30 minutes'),
           (P,   'wallet', 'checkout', 2000, 'paid',         now() - interval '1 day',      now()),
           (F,   'wallet', 'checkout', 2000, 'failed',       now() - interval '1 day',      now()),
           (R,   'wallet', 'checkout', 2000, 'needs_review', now() - interval '1 day',      now());

  -- first claim wins and stamps the row
  SELECT * INTO v_row FROM public.claim_hubtel_payment(A);
  IF v_row.reference IS DISTINCT FROM A THEN RAISE EXCEPTION 'FAIL claim_pending: no row returned'; END IF;
  IF v_row.status <> 'confirming' THEN RAISE EXCEPTION 'FAIL claim_pending: status %', v_row.status; END IF;
  IF v_row.claimed_at IS DISTINCT FROM now() THEN RAISE EXCEPTION 'FAIL claim_pending: claimed_at not now()'; END IF;
  IF v_row.updated_at IS DISTINCT FROM now() THEN RAISE EXCEPTION 'FAIL claim_pending: updated_at not now()'; END IF;

  -- second claim on the same (now freshly confirming) row loses
  SELECT count(*) INTO v_n FROM public.claim_hubtel_payment(A);
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL double_claim: second claim won (% rows)', v_n; END IF;

  -- 9-minute-old claim is not reclaimed
  SELECT count(*) INTO v_n FROM public.claim_hubtel_payment(B9);
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL stale_9min: reclaimed a 9-minute-old claim'; END IF;

  -- 11-minute-old claim is reclaimed
  SELECT * INTO v_row FROM public.claim_hubtel_payment(C11);
  IF v_row.reference IS DISTINCT FROM C11 THEN RAISE EXCEPTION 'FAIL stale_11min: 11-minute-old claim not reclaimed'; END IF;
  IF v_row.claimed_at IS DISTINCT FROM now() THEN RAISE EXCEPTION 'FAIL stale_11min: claimed_at not refreshed'; END IF;

  -- final states are never claimed
  SELECT count(*) INTO v_n FROM public.claim_hubtel_payment(P);
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL final_paid: paid row claimed'; END IF;
  SELECT count(*) INTO v_n FROM public.claim_hubtel_payment(F);
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL final_failed: failed row claimed'; END IF;
  SELECT count(*) INTO v_n FROM public.claim_hubtel_payment(R);
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL final_review: needs_review row claimed'; END IF;
  IF (SELECT status FROM public.hubtel_payments WHERE reference = P) <> 'paid' THEN
    RAISE EXCEPTION 'FAIL final_paid: status changed';
  END IF;

  -- unknown reference
  SELECT count(*) INTO v_n FROM public.claim_hubtel_payment('99999999999999999999999999999999');
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL unknown_ref: returned a row'; END IF;

  RAISE NOTICE 'SELFTEST_OK';
END
$selftest$;
