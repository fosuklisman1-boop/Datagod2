-- 0151_hubtel_payments.selftest.sql
--
-- NOT A MIGRATION. Local PGlite selftest (psql-only, no real database touched). Run from the repo root with a
-- runner that expands `\i` (see memory reference-pglite-sql-tests). PASSES when it prints 'SELFTEST_OK'; any
-- 'FAIL ...' notice/error means it failed.
--
-- Creates the Supabase roles and mirrors Supabase's default grants (ALL on new public tables to anon/authenticated,
-- as migration 0060 also does) so the REVOKE is really tested.
-- Scenarios: table_exists, rls_enabled, no_policies, no_anon_privs, index, internal_reference + metadata
-- (types, NULL by default, round-trip), handler_amount_pesewas + refused_at, one open attempt per order, valid_insert, opaque_reference
-- (WALLET-1 and uppercase hex refused), check constraints (mode, status, amount), status_default, anon_select
-- (anon sees nothing), idempotent re-run.

DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $r$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;

\i migrations/0151_hubtel_payments.sql
-- Re-run: must be idempotent.
\i migrations/0151_hubtel_payments.sql

DO $selftest$
DECLARE
  v_r      text;
  v_caught boolean;
  v_status text;
  v_n      integer;
BEGIN
  IF to_regclass('public.hubtel_payments') IS NULL THEN RAISE EXCEPTION 'FAIL table_exists: hubtel_payments missing'; END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.hubtel_payments'::regclass) THEN
    RAISE EXCEPTION 'FAIL rls_enabled: RLS off';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'hubtel_payments') THEN
    RAISE EXCEPTION 'FAIL no_policies: hubtel_payments must have no policies';
  END IF;
  FOREACH v_r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF has_table_privilege(v_r, 'public.hubtel_payments', 'SELECT')
       OR has_table_privilege(v_r, 'public.hubtel_payments', 'INSERT')
       OR has_table_privilege(v_r, 'public.hubtel_payments', 'UPDATE')
       OR has_table_privilege(v_r, 'public.hubtel_payments', 'DELETE') THEN
      RAISE EXCEPTION 'FAIL no_anon_privs: % has privileges on hubtel_payments', v_r;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.hubtel_payments'::regclass
       AND pg_get_indexdef(i.indexrelid) LIKE '%(status, created_at)%') THEN
    RAISE EXCEPTION 'FAIL index: (status, created_at) index missing';
  END IF;

  -- internal_reference / metadata: the types confirm.ts relies on
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hubtel_payments'
                  AND column_name = 'internal_reference' AND data_type = 'text' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'FAIL internal_reference: nullable text column missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hubtel_payments'
                  AND column_name = 'metadata' AND data_type = 'jsonb' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'FAIL metadata: nullable jsonb column missing';
  END IF;

  -- valid row; status defaults to pending; both new columns stay NULL unless set
  INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at)
    VALUES ('0123456789abcdef0123456789abcdef', 'wallet', 'checkout', 1000, now() + interval '30 minutes');
  SELECT status INTO v_status FROM public.hubtel_payments WHERE reference = '0123456789abcdef0123456789abcdef';
  IF v_status IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'FAIL status_default: got %', v_status; END IF;
  SELECT count(*) INTO v_n FROM public.hubtel_payments
   WHERE reference = '0123456789abcdef0123456789abcdef' AND internal_reference IS NULL AND metadata IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL new_columns_null: expected NULL defaults'; END IF;

  -- internal_reference can hold a surface reference (only the opaque reference has the shape CHECK) and metadata round-trips
  INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at, internal_reference, metadata)
    VALUES ('55555555555555555555555555555555', 'wallet', 'checkout', 1000, now(), 'WALLET-1', '{"type":"sms_bundle"}');
  SELECT count(*) INTO v_n FROM public.hubtel_payments
   WHERE reference = '55555555555555555555555555555555' AND internal_reference = 'WALLET-1' AND metadata->>'type' = 'sms_bundle';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL new_columns_roundtrip'; END IF;

  -- handler_amount_pesewas / refused_at: nullable, the types confirm.ts and sweep.ts rely on, NULL by default
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hubtel_payments'
                  AND column_name = 'handler_amount_pesewas' AND data_type = 'integer' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'FAIL handler_amount: nullable integer column missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hubtel_payments'
                  AND column_name = 'refused_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'FAIL refused_at: nullable timestamptz column missing';
  END IF;
  SELECT count(*) INTO v_n FROM public.hubtel_payments
   WHERE reference = '0123456789abcdef0123456789abcdef' AND handler_amount_pesewas IS NULL AND refused_at IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL new_columns2_null: expected NULL defaults'; END IF;
  v_caught := false;
  BEGIN
    INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, handler_amount_pesewas, expires_at)
      VALUES ('66666666666666666666666666666666', 'wallet', 'direct', 1000, 0, now());
  EXCEPTION WHEN check_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL handler_amount_check: zero handler amount accepted'; END IF;

  -- one open attempt per order (partial unique index). WALLET-1 is already open from the round-trip row above.
  v_caught := false;
  BEGIN
    INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at, internal_reference)
      VALUES ('77777777777777777777777777777777', 'wallet', 'direct', 1000, now(), 'WALLET-1');
  EXCEPTION WHEN unique_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL one_open_pending: second pending row for an order accepted'; END IF;

  -- a confirming row counts as open
  UPDATE public.hubtel_payments SET status = 'confirming', claimed_at = now() WHERE reference = '55555555555555555555555555555555';
  v_caught := false;
  BEGIN
    INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at, internal_reference)
      VALUES ('77777777777777777777777777777777', 'wallet', 'direct', 1000, now(), 'WALLET-1');
  EXCEPTION WHEN unique_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL one_open_confirming: pending alongside a confirming row accepted'; END IF;

  -- closed rows do not block a retry: failed, paid and needs_review can each sit beside a new open attempt
  UPDATE public.hubtel_payments SET status = 'failed', refused_at = now() WHERE reference = '55555555555555555555555555555555';
  INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at, internal_reference)
    VALUES ('77777777777777777777777777777777', 'wallet', 'direct', 1000, now(), 'WALLET-1');
  UPDATE public.hubtel_payments SET status = 'paid' WHERE reference = '77777777777777777777777777777777';
  INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at, internal_reference)
    VALUES ('88888888888888888888888888888888', 'wallet', 'direct', 1000, now(), 'WALLET-1');
  UPDATE public.hubtel_payments SET status = 'needs_review' WHERE reference = '88888888888888888888888888888888';
  INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at, internal_reference)
    VALUES ('99999999999999999999999999999999', 'wallet', 'direct', 1000, now(), 'WALLET-1');

  -- rows with no internal_reference are not limited, and another order is unaffected
  INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at)
    VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'wallet', 'direct', 1000, now()),
           ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'wallet', 'direct', 1000, now());
  INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at, internal_reference)
    VALUES ('cccccccccccccccccccccccccccccccc', 'wallet', 'direct', 1000, now(), 'WALLET-2');

  -- opaque reference: a WALLET- reference is refused
  v_caught := false;
  BEGIN
    INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at)
      VALUES ('WALLET-1', 'wallet', 'checkout', 1000, now());
  EXCEPTION WHEN check_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL opaque_reference: WALLET-1 accepted'; END IF;

  -- uppercase hex is refused too (references are lowercase only)
  v_caught := false;
  BEGIN
    INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at)
      VALUES ('0123456789ABCDEF0123456789ABCDEF', 'wallet', 'checkout', 1000, now());
  EXCEPTION WHEN check_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL opaque_reference_case: uppercase accepted'; END IF;

  -- mode check
  v_caught := false;
  BEGIN
    INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at)
      VALUES ('11111111111111111111111111111111', 'wallet', 'bogus', 1000, now());
  EXCEPTION WHEN check_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL mode_check: bogus mode accepted'; END IF;

  -- status check
  v_caught := false;
  BEGIN
    INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, status, expires_at)
      VALUES ('22222222222222222222222222222222', 'wallet', 'direct', 1000, 'bogus', now());
  EXCEPTION WHEN check_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL status_check: bogus status accepted'; END IF;

  -- amount must be positive
  v_caught := false;
  BEGIN
    INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas, expires_at)
      VALUES ('33333333333333333333333333333333', 'wallet', 'direct', 0, now());
  EXCEPTION WHEN check_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL amount_check: zero amount accepted'; END IF;

  -- expires_at required
  v_caught := false;
  BEGIN
    INSERT INTO public.hubtel_payments (reference, surface, mode, amount_pesewas)
      VALUES ('44444444444444444444444444444444', 'wallet', 'direct', 100);
  EXCEPTION WHEN not_null_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL expires_not_null: missing expires_at accepted'; END IF;

  -- anon select returns nothing (permission denied, or zero rows if a grant ever slipped through RLS)
  v_n := NULL;
  BEGIN
    SET LOCAL ROLE anon;
    SELECT count(*) INTO v_n FROM public.hubtel_payments;
  EXCEPTION WHEN insufficient_privilege THEN v_n := 0; END;
  RESET ROLE;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL anon_select: anon saw % rows', v_n; END IF;

  RAISE NOTICE 'SELFTEST_OK';
END
$selftest$;
