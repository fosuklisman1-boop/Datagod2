-- 0157_hubtel_payments_refunded_manually.selftest.sql
--
-- NOT A MIGRATION. Local PGlite selftest (psql-only, no real database touched). Run from the repo root with a
-- runner that expands `\i` (see memory reference-pglite-sql-tests). PASSES when it prints 'SELFTEST_OK'.
--
-- Uses the real 0151 and 0152. Scenarios: before the migration refunded_manually is refused; after it, it and every old
-- status write and other values are still refused; existing rows survive; manual_refund holds and returns the admin's
-- details; a refunded_manually row sits beside an open attempt and is never claimed; idempotent re-run.

DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $r$;

\i migrations/0151_hubtel_payments.sql
\i migrations/0152_claim_hubtel_payment.sql

INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at, status)
VALUES ('11111111111111111111111111111111', 'wallet', 'checkout', 2000, now() + interval '1 hour', 'needs_review');

DO $before$ BEGIN
  BEGIN
    UPDATE public.hubtel_payments SET status = 'refunded_manually';
    RAISE EXCEPTION 'FAIL fixture: refunded_manually allowed before the migration';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $before$;

\i migrations/0157_hubtel_payments_refunded_manually.sql
-- Re-run: must be idempotent.
\i migrations/0157_hubtel_payments_refunded_manually.sql

DO $selftest$
DECLARE
  R text := '11111111111111111111111111111111';
  OPEN_R text := '22222222222222222222222222222222';
  v_status text; v_ref text; v_n int; v_convalidated boolean;
BEGIN
  SELECT status INTO v_status FROM public.hubtel_payments WHERE reference = R;
  IF v_status <> 'needs_review' THEN RAISE EXCEPTION 'FAIL existing row changed: %', v_status; END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.hubtel_payments'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%needs_review%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL expected one status CHECK, found %', v_n; END IF;
  SELECT convalidated INTO v_convalidated FROM pg_constraint WHERE conname = 'hubtel_payments_status_check';
  IF v_convalidated IS NOT TRUE THEN RAISE EXCEPTION 'FAIL the CHECK was left not validated'; END IF;

  UPDATE public.hubtel_payments
     SET status = 'refunded_manually',
         manual_refund = jsonb_build_object('admin_reference', 'MP241105.1234', 'note', 'Paid back', 'admin_id', 'a1', 'recorded_at', now())
   WHERE reference = R AND status = 'needs_review';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL first guarded update wrote % rows', v_n; END IF;

  -- The same guarded update again changes nothing: the second click.
  UPDATE public.hubtel_payments SET status = 'refunded_manually' WHERE reference = R AND status = 'needs_review';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL second guarded update wrote % rows', v_n; END IF;

  SELECT manual_refund->>'admin_reference' INTO v_ref FROM public.hubtel_payments WHERE reference = R;
  IF v_ref <> 'MP241105.1234' THEN RAISE EXCEPTION 'FAIL manual_refund: %', v_ref; END IF;

  -- Never claimed, whatever its age: the claim RPC opens only pending and stale confirming rows.
  UPDATE public.hubtel_payments SET claimed_at = now() - interval '1 day', created_at = now() - interval '2 days' WHERE reference = R;
  SELECT count(*) INTO v_n FROM public.claim_hubtel_payment(R);
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL refunded_manually row was claimed'; END IF;
  SELECT status INTO v_status FROM public.hubtel_payments WHERE reference = R;
  IF v_status <> 'refunded_manually' THEN RAISE EXCEPTION 'FAIL claim moved the row: %', v_status; END IF;

  -- It does not count as an open attempt: a new one for the same order can sit beside it.
  UPDATE public.hubtel_payments SET internal_reference = 'WALLET-1' WHERE reference = R;
  INSERT INTO public.hubtel_payments (reference, internal_reference, surface, mode, amount_pesewas, expires_at)
  VALUES (OPEN_R, 'WALLET-1', 'wallet', 'checkout', 2000, now() + interval '1 hour');

  -- Every old status still writes; anything else is still refused.
  FOREACH v_status IN ARRAY ARRAY['pending', 'confirming', 'paid', 'failed', 'needs_review'] LOOP
    UPDATE public.hubtel_payments SET status = v_status WHERE reference = OPEN_R;
  END LOOP;
  BEGIN
    UPDATE public.hubtel_payments SET status = 'nonsense' WHERE reference = OPEN_R;
    RAISE EXCEPTION 'FAIL nonsense allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;

  RAISE NOTICE 'SELFTEST_OK';
END $selftest$;
