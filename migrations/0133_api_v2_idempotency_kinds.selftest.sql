-- 0133_api_v2_idempotency_kinds.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0133_api_v2_idempotency_kinds.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a
-- regex strip, and that code must ASSERT before anything is sent to
-- production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs).
-- (The 0130 incident lesson.) Build it as:
--   1. 0133_api_v2_idempotency_kinds.sql with BEGIN kept (and both SET LOCALs)
--      and ONLY its final transaction-ending line removed; the trailing
--      "Verify after apply" comment lines may stay (they contain no SQL);
--   2. followed by this file from the line that STARTS (column 0) with the
--      DO keyword onward; anchor on that line start, not on a substring
--      search, because this header mentions the same token. The header is
--      not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: every sub-block is labelled
--   (`END kind_bad;` etc.), so a statement-level check works.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit
-- transaction, so the widened check, the throwaway api_v2_keys row and every
-- claim row are rolled back. The run PASSES when the error text starts with
-- 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed. If the client
-- keeps the session open afterwards, send `ROLLBACK;`.
--
-- Picks the first admin (public.users.role = 'admin' joined to auth.users) and
-- a REVOKED TEST commission key (cannot collide with
-- api_v2_keys_one_live_per_type, which covers only pending/active, and can
-- never authenticate), exactly as the 0132 selftest does.
--
-- Types: user and key ids are uuid held in uuid variables; kind, reference,
-- request_hash are text; the hash is built with
-- encode(sha256(convert_to(..., 'UTF8')), 'hex'); count(*) (bigint) goes into
-- an int.

DO $selftest$
DECLARE
  v_user uuid;
  v_key uuid;
  v_ref text := 'selftest-' || gen_random_uuid()::text;
  v_hash text := encode(sha256(convert_to('selftest 0133 ' || gen_random_uuid()::text, 'UTF8')), 'hex');
  v_kind text;
  v_def text;
  v_n int;
BEGIN
  -- Setup -------------------------------------------------------------------
  SELECT u.id INTO v_user
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  WHERE u.role = 'admin'
  ORDER BY u.id
  LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'FAIL setup: no admin user';
  END IF;

  INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix, revoked_at)
  VALUES (v_user, 'commission', 'test', 'revoked', 'selftest 0133',
          'selftest-' || gen_random_uuid()::text, 'selftest', now())
  RETURNING id INTO v_key;

  -- Catalog: exactly one kind check, listing all four kinds -----------------
  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conrelid = 'public.api_v2_idempotency'::regclass
    AND conname = 'api_v2_idempotency_kind_check';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL catalog: expected 1 kind check, found %', v_n;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
  WHERE conrelid = 'public.api_v2_idempotency'::regclass
    AND conname = 'api_v2_idempotency_kind_check';
  IF v_def NOT LIKE '%''airtime''%' OR v_def NOT LIKE '%''bill''%'
     OR v_def NOT LIKE '%''results''%' OR v_def NOT LIKE '%''afa''%' THEN
    RAISE EXCEPTION 'FAIL catalog: kind check is %', v_def;
  END IF;

  -- 1. One claim per kind: all four are accepted ----------------------------
  FOREACH v_kind IN ARRAY ARRAY['airtime', 'bill', 'results', 'afa'] LOOP
    INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
    VALUES (v_user, v_key, v_kind, 'selftest-' || v_kind || '-' || gen_random_uuid()::text, v_hash);
  END LOOP;
  SELECT count(*) INTO v_n FROM public.api_v2_idempotency
  WHERE api_v2_key_id = v_key AND kind IN ('airtime', 'bill', 'results', 'afa');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'FAIL 1: expected 4 claims (one per kind), found %', v_n;
  END IF;

  -- 2. Unknown kinds are still rejected -------------------------------------
  FOREACH v_kind IN ARRAY ARRAY['sms', 'data', 'AFA', 'Results', ''] LOOP
    <<kind_bad>>
    BEGIN
      INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
      VALUES (v_user, v_key, v_kind, 'selftest-' || gen_random_uuid()::text, v_hash);
      RAISE EXCEPTION 'FAIL 2: kind % accepted', v_kind;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END kind_bad;
  END LOOP;

  -- 3. The same reference under different kinds is allowed ------------------
  FOREACH v_kind IN ARRAY ARRAY['airtime', 'bill', 'results', 'afa'] LOOP
    INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
    VALUES (v_user, v_key, v_kind, v_ref, v_hash);
  END LOOP;
  SELECT count(*) INTO v_n FROM public.api_v2_idempotency WHERE reference = v_ref;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'FAIL 3: expected 4 rows for the shared reference, found %', v_n;
  END IF;

  -- 4. ...but the same reference under the SAME kind is still refused -------
  FOREACH v_kind IN ARRAY ARRAY['results', 'afa'] LOOP
    <<dup_same_kind>>
    BEGIN
      INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
      VALUES (v_user, v_key, v_kind, v_ref, v_hash);
      RAISE EXCEPTION 'FAIL 4: duplicate % claim accepted', v_kind;
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END dup_same_kind;
  END LOOP;

  -- Always roll back. -------------------------------------------------------
  RAISE EXCEPTION 'SELFTEST_OK 0133: all scenarios passed; rolling back';
END $selftest$;
