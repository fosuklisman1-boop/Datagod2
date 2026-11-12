-- 0162_api_v1_retirement.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0162_api_v1_retirement.sql (on a database where 0128 is applied).
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must ASSERT before
-- anything is sent to production that the run string contains no COMMIT and no bare `END;` statement, and that it ends
-- with this DO block (which always RAISEs). (The 0130 incident lesson.) Build it as lib/api-v1/migration-0162.test.ts does:
--   1. 0162_api_v1_retirement.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward.
-- The DO body has no bare `END;`: the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new columns are rolled back.
-- PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed. If the client keeps
-- the session open, send `ROLLBACK;`.
--
-- Scenarios (labels): columns, existing_row, anon_locked.

DO $selftest$
DECLARE
  v_type text;
  v_null text;
  v_def  text;
  v_n    int;
  v_row  public.api_v2_config%ROWTYPE;
BEGIN
  -- columns: the three columns exist with the stated types, nullability and defaults ------------------------------------
  SELECT data_type, is_nullable, column_default INTO v_type, v_null, v_def FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'api_v2_config' AND column_name = 'v1_sunset_at';
  IF v_type IS DISTINCT FROM 'timestamp with time zone' OR v_null <> 'YES' OR v_def IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL columns: v1_sunset_at is % / % / %', v_type, v_null, v_def;
  END IF;
  SELECT data_type, is_nullable, column_default INTO v_type, v_null, v_def FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'api_v2_config' AND column_name = 'v1_notice_sent_at';
  IF v_type IS DISTINCT FROM 'timestamp with time zone' OR v_null <> 'YES' OR v_def IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL columns: v1_notice_sent_at is % / % / %', v_type, v_null, v_def;
  END IF;
  SELECT data_type, is_nullable, column_default INTO v_type, v_null, v_def FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'api_v2_config' AND column_name = 'v1_exempt_user_ids';
  IF v_type IS DISTINCT FROM 'ARRAY' OR v_null <> 'NO' OR v_def IS NULL OR position('''{}''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL columns: v1_exempt_user_ids is % / % / %', v_type, v_null, v_def;
  END IF;
  SELECT count(*) INTO v_n FROM pg_attribute a
   WHERE a.attrelid = 'public.api_v2_config'::regclass AND a.attname = 'v1_exempt_user_ids' AND a.atttypid = 'uuid[]'::regtype;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL columns: v1_exempt_user_ids is not uuid[]'; END IF;

  -- existing_row: the single row is intact, with no sunset, no exemptions, no notice ----------------------------------
  SELECT count(*) INTO v_n FROM public.api_v2_config;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL existing_row: % config rows', v_n; END IF;
  SELECT * INTO v_row FROM public.api_v2_config;
  IF v_row.v1_sunset_at IS NOT NULL THEN RAISE EXCEPTION 'FAIL existing_row: v1_sunset_at is %', v_row.v1_sunset_at; END IF;
  IF v_row.v1_exempt_user_ids IS DISTINCT FROM '{}'::uuid[] THEN RAISE EXCEPTION 'FAIL existing_row: v1_exempt_user_ids is %', v_row.v1_exempt_user_ids; END IF;
  IF v_row.v1_notice_sent_at IS NOT NULL THEN RAISE EXCEPTION 'FAIL existing_row: v1_notice_sent_at is %', v_row.v1_notice_sent_at; END IF;

  -- anon_locked: RLS still on, anon/authenticated cannot read the table ------------------------------------------------
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.api_v2_config'::regclass) THEN
    RAISE EXCEPTION 'FAIL anon_locked: RLS is off on api_v2_config';
  END IF;
  IF has_table_privilege('anon', 'public.api_v2_config', 'SELECT') OR has_table_privilege('authenticated', 'public.api_v2_config', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL anon_locked: anon or authenticated can SELECT api_v2_config';
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0162';
END $selftest$;
