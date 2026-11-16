-- 0164_rate_limit_fallback.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0164_rate_limit_fallback.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand, and that code must ASSERT that the run string contains
-- no COMMIT and no bare `END;` statement and ends with this DO block (which always RAISEs). Build it as
-- lib/rate-limit-fallback-migration.test.ts does: 0164 with BEGIN kept and ONLY its final COMMIT line removed, followed by
-- this file from the line that STARTS (column 0) with the DO keyword onward. The DO body has no bare `END;`.
-- PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' means it failed. If the session stays open, ROLLBACK;
--
-- Scenarios: shape, three_hits_max_two, other_bucket, bad_input, grants.

DO $selftest$
DECLARE
  v_a boolean; v_b boolean; v_c boolean;
  v_rem int;
  v_reset timestamptz;
  v_n int;
  v_src text;
BEGIN
  -- shape: RLS on, no policies, anon/authenticated have no table privilege ------------------------------------------------
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rate_limit_fallback'::regclass) THEN
    RAISE EXCEPTION 'FAIL shape: RLS is off';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rate_limit_fallback';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL shape: % policies', v_n; END IF;
  IF has_table_privilege('anon', 'public.rate_limit_fallback', 'SELECT')
     OR has_table_privilege('authenticated', 'public.rate_limit_fallback', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL shape: anon or authenticated can read the table';
  END IF;

  -- three_hits_max_two: allowed, allowed, denied -----------------------------------------------------------------------------
  SELECT f.allowed, f.remaining INTO v_a, v_rem FROM public.rate_limit_fallback_hit('selftest:user:a', 2, 60) f;
  IF NOT v_a OR v_rem <> 1 THEN RAISE EXCEPTION 'FAIL three_hits_max_two: hit 1 gave % / %', v_a, v_rem; END IF;
  SELECT f.allowed, f.remaining INTO v_b, v_rem FROM public.rate_limit_fallback_hit('selftest:user:a', 2, 60) f;
  IF NOT v_b OR v_rem <> 0 THEN RAISE EXCEPTION 'FAIL three_hits_max_two: hit 2 gave % / %', v_b, v_rem; END IF;
  SELECT f.allowed, f.remaining, f.reset_at INTO v_c, v_rem, v_reset FROM public.rate_limit_fallback_hit('selftest:user:a', 2, 60) f;
  IF v_c OR v_rem <> 0 THEN RAISE EXCEPTION 'FAIL three_hits_max_two: hit 3 gave % / %', v_c, v_rem; END IF;
  IF v_reset <= now() OR v_reset > now() + interval '60 seconds' THEN
    RAISE EXCEPTION 'FAIL three_hits_max_two: reset_at % is not within the window', v_reset;
  END IF;

  -- other_bucket: a different bucket starts at 1 ------------------------------------------------------------------------------
  SELECT f.allowed, f.remaining INTO v_a, v_rem FROM public.rate_limit_fallback_hit('selftest:user:b', 2, 60) f;
  IF NOT v_a OR v_rem <> 1 THEN RAISE EXCEPTION 'FAIL other_bucket: gave % / %', v_a, v_rem; END IF;
  SELECT r.hits INTO v_n FROM public.rate_limit_fallback r WHERE r.bucket = 'selftest:user:a';
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL other_bucket: bucket a has % hits, want 3', v_n; END IF;

  -- bad_input: zero or negative max / window is refused ----------------------------------------------------------------------
  --   (no sub-block: the run string may not contain a bare END; line, so the guard is checked in the function source and
  --   the behaviour is covered by the PGlite test)
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.rate_limit_fallback_hit(text,int,int)'::regprocedure;
  IF strpos(v_src, 'p_max <= 0') = 0 OR strpos(v_src, 'p_window_seconds <= 0') = 0 OR strpos(v_src, 'BAD_INPUT') = 0 THEN
    RAISE EXCEPTION 'FAIL bad_input: the input guard is missing';
  END IF;

  -- grants: service_role only; anon denied --------------------------------------------------------------------------------------
  IF has_function_privilege('anon', 'public.rate_limit_fallback_hit(text,int,int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rate_limit_fallback_hit(text,int,int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL grants: anon or authenticated can execute the RPC';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.rate_limit_fallback_hit(text,int,int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL grants: service_role cannot execute the RPC';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = 'public.rate_limit_fallback_hit(text,int,int)'::regprocedure AND a.grantee = 0;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL grants: PUBLIC has a privilege on the RPC'; END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0164 rate limit fallback: fixed window counts, buckets isolated, service_role only';
END $selftest$;
