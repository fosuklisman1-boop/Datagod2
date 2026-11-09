-- 0150_kuntanii_provider.selftest.sql
--
-- NOT A MIGRATION. Local PGlite selftest (psql-only, no real database touched). Run from the repo root with a
-- runner that expands `\i` (see memory reference-pglite-sql-tests). PASSES when it prints 'SELFTEST_OK'; any
-- 'FAIL ...' notice/error means it failed.
--
-- Stubs the one pre-existing table the migration alters (mtn_fulfillment_tracking) and the Supabase roles, and
-- mirrors Supabase's default grants (ALL on new public tables to anon/authenticated) so the REVOKE is really tested.
-- Scenarios: columns, tables_exist, rls_enabled, no_anon_privs, unique_open, check_constraint, idempotent re-run.

CREATE TABLE public.mtn_fulfillment_tracking (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
INSERT INTO public.mtn_fulfillment_tracking DEFAULT VALUES;

DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $r$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;

\i migrations/0150_kuntanii_provider.sql
-- Re-run: must be idempotent.
\i migrations/0150_kuntanii_provider.sql

DO $selftest$
DECLARE
  v_trk   uuid;
  v_t     text;
  v_r     text;
  v_caught boolean;
  v_def   text;
BEGIN
  SELECT id INTO v_trk FROM public.mtn_fulfillment_tracking LIMIT 1;

  -- columns
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='mtn_fulfillment_tracking'
         AND ((column_name='provider_cost_ghs' AND data_type='numeric' AND numeric_precision=12 AND numeric_scale=2)
           OR (column_name='provider_reference' AND data_type='text'))) <> 2 THEN
    RAISE EXCEPTION 'FAIL columns: provider_cost_ghs numeric(12,2) / provider_reference text missing';
  END IF;

  -- tables exist + RLS + no anon/authenticated privileges
  FOREACH v_t IN ARRAY ARRAY['kuntanii_not_received_reports','kuntanii_unknown_attempts'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN RAISE EXCEPTION 'FAIL tables_exist: % missing', v_t; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass) THEN
      RAISE EXCEPTION 'FAIL rls_enabled: % has RLS off', v_t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=v_t) THEN
      RAISE EXCEPTION 'FAIL policies: % must have no policies', v_t;
    END IF;
    FOREACH v_r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF has_table_privilege(v_r, 'public.' || v_t, 'SELECT')
         OR has_table_privilege(v_r, 'public.' || v_t, 'INSERT')
         OR has_table_privilege(v_r, 'public.' || v_t, 'UPDATE')
         OR has_table_privilege(v_r, 'public.' || v_t, 'DELETE') THEN
        RAISE EXCEPTION 'FAIL no_anon_privs: % has privileges on %', v_r, v_t;
      END IF;
    END LOOP;
  END LOOP;

  -- partial unique index: second open/escalated report for one tracking row is refused
  INSERT INTO public.kuntanii_not_received_reports (tracking_id, external_order_id, report_reference, dispute_status)
    VALUES (v_trk, 'ext-1', 'rep-1', 'open');
  v_caught := false;
  BEGIN
    INSERT INTO public.kuntanii_not_received_reports (tracking_id, external_order_id, report_reference, dispute_status)
      VALUES (v_trk, 'ext-1', 'rep-2', 'escalated');
  EXCEPTION WHEN unique_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL unique_open: second open report was accepted'; END IF;

  -- a resolved report does not block a new open one
  UPDATE public.kuntanii_not_received_reports SET dispute_status = 'resolved' WHERE report_reference = 'rep-1';
  INSERT INTO public.kuntanii_not_received_reports (tracking_id, external_order_id, report_reference, dispute_status)
    VALUES (v_trk, 'ext-1', 'rep-3', 'open');

  -- report_reference unique
  v_caught := false;
  BEGIN
    INSERT INTO public.kuntanii_not_received_reports (tracking_id, external_order_id, report_reference, dispute_status)
      VALUES (v_trk, 'ext-1', 'rep-1', 'rejected');
  EXCEPTION WHEN unique_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL report_reference_unique: duplicate accepted'; END IF;

  -- CHECK constraint
  v_caught := false;
  BEGIN
    INSERT INTO public.kuntanii_not_received_reports (tracking_id, external_order_id, report_reference, dispute_status)
      VALUES (v_trk, 'ext-1', 'rep-4', 'bogus');
  EXCEPTION WHEN check_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL check_constraint: dispute_status bogus accepted'; END IF;

  -- unknown attempts: text order_id, nullable order_type, unique external_order_id
  INSERT INTO public.kuntanii_unknown_attempts (external_order_id, order_id) VALUES ('ext-u1', 'not-a-uuid-order');
  v_caught := false;
  BEGIN
    INSERT INTO public.kuntanii_unknown_attempts (external_order_id) VALUES ('ext-u1');
  EXCEPTION WHEN unique_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL unknown_unique: duplicate external_order_id accepted'; END IF;

  -- claim-first: an open placeholder with NULL report_reference is allowed; a second one for the same tracking is not
  INSERT INTO public.mtn_fulfillment_tracking DEFAULT VALUES;
  SELECT id INTO v_trk FROM public.mtn_fulfillment_tracking
   WHERE id NOT IN (SELECT tracking_id FROM public.kuntanii_not_received_reports) LIMIT 1;
  INSERT INTO public.kuntanii_not_received_reports (tracking_id, external_order_id, report_reference, dispute_status)
    VALUES (v_trk, 'ext-2', NULL, 'open');
  v_caught := false;
  BEGIN
    INSERT INTO public.kuntanii_not_received_reports (tracking_id, external_order_id, report_reference, dispute_status)
      VALUES (v_trk, 'ext-2', NULL, 'open');
  EXCEPTION WHEN unique_violation THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL claim_gate_null_ref: second open NULL-reference report accepted'; END IF;

  RAISE NOTICE 'SELFTEST_OK';
END
$selftest$;
