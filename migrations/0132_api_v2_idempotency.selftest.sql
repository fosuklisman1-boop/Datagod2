-- 0132_api_v2_idempotency.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0132_api_v2_idempotency.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a
-- regex strip, and that code must ASSERT before anything is sent to
-- production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs).
-- Build it as:
--   1. 0132_api_v2_idempotency.sql with BEGIN kept (and both SET LOCALs) and
--      ONLY its final transaction-ending line removed; the trailing
--      "Verify after apply" comment lines may stay (they contain no SQL);
--   2. followed by this file from the line that STARTS (column 0) with the
--      DO keyword onward; anchor on that line start, not on a substring
--      search, because this header mentions the same token. The header is
--      not part of the run string (it names the forbidden words).
--   The DO body below deliberately has no bare `END;`: every sub-block is
--   labelled (`END dup;` etc.), so a simple statement-level check works.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit
-- transaction whatever the client does, so the new table, the throwaway
-- api_v2_keys row and every claim row are rolled back. If the client keeps the
-- session open afterwards, send `ROLLBACK;`. The run PASSES when the error
-- text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it
-- failed. After the real apply the DO block can also be run alone inside
-- `BEGIN; ...` (never ended with a commit).
--
-- What it cannot cover: true two-session races. Those rely on the unique
-- index: a second INSERT of the same (user_id, kind, reference) waits on the
-- first transaction's uncommitted index entry and then raises
-- unique_violation (or succeeds if the first rolled back / the row was
-- deleted). One session cannot exercise the wait.
--
-- Picks: the first admin (public.users.role = 'admin' joined to auth.users)
-- and a second auth user. The throwaway key is a REVOKED TEST commission key,
-- so it can never collide with api_v2_keys_one_live_per_type (that partial
-- index covers only pending/active) and can never authenticate.
--
-- Types: api_v2_idempotency.id, user_id, api_v2_key_id and api_v2_keys.id are
-- uuid (held in uuid variables, never compared with text); reference,
-- request_hash, kind, status and order_ref are text; order_ref is filled with
-- gen_random_uuid()::text; response is jsonb; hashes are built with
-- encode(sha256(convert_to(..., 'UTF8')), 'hex') (text); pg_constraint
-- confdeltype is "char" and is compared as ::text; role names are passed to
-- has_table_privilege as ::name; count(*) (bigint) is assigned to int.

DO $selftest$
DECLARE
  v_tbl CONSTANT text := 'public.api_v2_idempotency';
  v_user uuid;
  v_other uuid;
  v_key uuid;
  v_claim uuid;
  v_bill uuid;
  v_ref text := 'selftest-' || gen_random_uuid()::text;
  v_hash text := encode(sha256(convert_to('selftest 0132 a ' || gen_random_uuid()::text, 'UTF8')), 'hex');
  v_hash2 text := encode(sha256(convert_to('selftest 0132 b ' || gen_random_uuid()::text, 'UTF8')), 'hex');
  v_status text;
  v_text text;
  v_con text;
  v_bad text;
  v_role text;
  v_priv text;
  v_rls boolean;
  v_n int;
BEGIN
  -- Setup -------------------------------------------------------------------
  IF char_length(v_hash) <> 64 OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'FAIL setup: test hash is not 64 lowercase hex chars: %', v_hash;
  END IF;

  SELECT u.id INTO v_user
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  WHERE u.role = 'admin'
  ORDER BY u.id
  LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'FAIL setup: no admin user';
  END IF;

  SELECT au.id INTO v_other FROM auth.users au WHERE au.id <> v_user LIMIT 1;
  IF v_other IS NULL THEN
    RAISE EXCEPTION 'FAIL setup: no second auth user';
  END IF;

  INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix, revoked_at)
  VALUES (v_user, 'commission', 'test', 'revoked', 'selftest 0132',
          'selftest-' || gen_random_uuid()::text, 'selftest', now())
  RETURNING id INTO v_key;

  -- Catalog: RLS, policies, privileges, FK actions, unique definition --------
  SELECT c.relrowsecurity INTO v_rls FROM pg_class c WHERE c.oid = v_tbl::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL catalog: RLS is not enabled on %', v_tbl;
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'api_v2_idempotency';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL catalog: expected 0 policies, found %', v_n;
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role::name, v_tbl, v_priv) THEN
        RAISE EXCEPTION 'FAIL privileges: % holds % on %', v_role, v_priv, v_tbl;
      END IF;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege(v_role::name, v_tbl, v_priv) THEN
        RAISE EXCEPTION 'FAIL privileges: % holds column-level % on %', v_role, v_priv, v_tbl;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role'::name, v_tbl, v_priv) THEN
      RAISE EXCEPTION 'FAIL privileges: service_role lacks % on %', v_priv, v_tbl;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conrelid = v_tbl::regclass
    AND conname = 'api_v2_idempotency_user_id_fkey'
    AND contype = 'f'
    AND confrelid = 'auth.users'::regclass
    AND confdeltype::text = 'c';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL catalog: user_id FK is not auth.users ON DELETE CASCADE';
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conrelid = v_tbl::regclass
    AND conname = 'api_v2_idempotency_api_v2_key_id_fkey'
    AND contype = 'f'
    AND confrelid = 'public.api_v2_keys'::regclass
    AND confdeltype::text = 'a';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL catalog: api_v2_key_id FK is not api_v2_keys ON DELETE NO ACTION';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_text FROM pg_constraint
  WHERE conrelid = v_tbl::regclass AND conname = 'api_v2_idempotency_user_kind_reference_key';
  IF v_text IS DISTINCT FROM 'UNIQUE (user_id, kind, reference)' THEN
    RAISE EXCEPTION 'FAIL catalog: unique claim constraint is %', v_text;
  END IF;

  SELECT count(*) INTO v_n FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN ('api_v2_idempotency_user_kind_created_idx',
                      'api_v2_idempotency_open_status_created_idx');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'FAIL catalog: expected 2 secondary indexes, found %', v_n;
  END IF;

  -- 1. First claim inserts, defaults to in_progress ---------------------------
  INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
  VALUES (v_user, v_key, 'airtime', v_ref, v_hash)
  RETURNING id, status INTO v_claim, v_status;
  IF v_claim IS NULL OR v_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'FAIL 1: first claim id % status %', v_claim, v_status;
  END IF;

  -- 2. Duplicate (user, kind, reference) is refused, whatever the hash -------
  FOREACH v_bad IN ARRAY ARRAY[v_hash, v_hash2] LOOP
    <<dup>>
    BEGIN
      INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
      VALUES (v_user, v_key, 'airtime', v_ref, v_bad);
      RAISE EXCEPTION 'FAIL 2: duplicate claim accepted (hash %)', v_bad;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
      IF v_con IS DISTINCT FROM 'api_v2_idempotency_user_kind_reference_key' THEN
        RAISE EXCEPTION 'FAIL 2: duplicate refused by % instead of the claim key', v_con;
      END IF;
    END dup;
  END LOOP;

  -- 3. Same reference, other kind is allowed; other user is allowed ----------
  INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
  VALUES (v_user, v_key, 'bill', v_ref, v_hash)
  RETURNING id INTO v_bill;
  -- (the key belongs to v_user; the schema does not tie key to user, the
  --  route does; this only shows the claim namespace is per user)
  INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
  VALUES (v_other, v_key, 'airtime', v_ref, v_hash);
  SELECT count(*) INTO v_n FROM public.api_v2_idempotency WHERE reference = v_ref;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'FAIL 3: expected 3 rows for the reference, got %', v_n;
  END IF;

  -- 4. Invalid kind ----------------------------------------------------------
  FOREACH v_bad IN ARRAY ARRAY['data', 'AIRTIME', 'Bill', ''] LOOP
    <<badkind>>
    BEGIN
      INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
      VALUES (v_user, v_key, v_bad, 'selftest-' || gen_random_uuid()::text, v_hash);
      RAISE EXCEPTION 'FAIL 4: kind % accepted', v_bad;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END badkind;
  END LOOP;

  -- 5. Invalid status --------------------------------------------------------
  FOREACH v_bad IN ARRAY ARRAY['pending', 'completed', 'DONE', ''] LOOP
    <<badstatus>>
    BEGIN
      INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash, status)
      VALUES (v_user, v_key, 'airtime', 'selftest-' || gen_random_uuid()::text, v_hash, v_bad);
      RAISE EXCEPTION 'FAIL 5: status % accepted', v_bad;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END badstatus;
  END LOOP;

  -- 6. Reference length 3..100 ------------------------------------------------
  FOREACH v_bad IN ARRAY ARRAY['', 'ab', rpad('selftest-' || gen_random_uuid()::text, 101, 'x')] LOOP
    <<badref>>
    BEGIN
      INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
      VALUES (v_user, v_key, 'airtime', v_bad, v_hash);
      RAISE EXCEPTION 'FAIL 6: reference of length % accepted', char_length(v_bad);
    EXCEPTION WHEN check_violation THEN
      NULL;
    END badref;
  END LOOP;
  -- The bounds themselves are accepted.
  v_text := left(replace(gen_random_uuid()::text, '-', ''), 3);
  INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
  VALUES (v_user, v_key, 'airtime', v_text, v_hash);
  v_text := rpad('selftest-' || gen_random_uuid()::text, 100, 'x');
  IF char_length(v_text) <> 100 THEN
    RAISE EXCEPTION 'FAIL 6: setup: 100-char reference has length %', char_length(v_text);
  END IF;
  INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
  VALUES (v_user, v_key, 'airtime', v_text, v_hash);

  -- 7. request_hash must be 64 lowercase hex chars ---------------------------
  FOREACH v_bad IN ARRAY ARRAY[upper(v_hash), left(v_hash, 63), v_hash || '0', repeat('g', 64),
                               v_hash || E'\n', ' ' || left(v_hash, 63), ''] LOOP
    <<badhash>>
    BEGIN
      INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
      VALUES (v_user, v_key, 'airtime', 'selftest-' || gen_random_uuid()::text, v_bad);
      RAISE EXCEPTION 'FAIL 7: request_hash % accepted', v_bad;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END badhash;
  END LOOP;

  -- 8. done needs order_ref AND response -------------------------------------
  <<done_no_ref>>
  BEGIN
    INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash,
                                           status, order_ref, response, completed_at)
    VALUES (v_user, v_key, 'airtime', 'selftest-' || gen_random_uuid()::text, v_hash,
            'done', NULL, '{"status": "pending"}'::jsonb, now());
    RAISE EXCEPTION 'FAIL 8: done row without order_ref accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END done_no_ref;
  <<done_no_resp>>
  BEGIN
    INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash,
                                           status, order_ref, response, completed_at)
    VALUES (v_user, v_key, 'airtime', 'selftest-' || gen_random_uuid()::text, v_hash,
            'done', gen_random_uuid()::text, NULL, now());
    RAISE EXCEPTION 'FAIL 8: done row without response accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END done_no_resp;
  -- The real finalisation path is an UPDATE of the in_progress claim.
  <<done_update_bare>>
  BEGIN
    UPDATE public.api_v2_idempotency SET status = 'done', completed_at = now() WHERE id = v_claim;
    RAISE EXCEPTION 'FAIL 8: claim updated to done without order_ref/response';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END done_update_bare;
  -- A complete done row is accepted, both by UPDATE and by INSERT.
  UPDATE public.api_v2_idempotency
  SET status = 'done',
      order_ref = gen_random_uuid()::text,
      response = jsonb_build_object('reference', v_ref, 'status', 'pending'),
      completed_at = now()
  WHERE id = v_claim AND status = 'in_progress'
  RETURNING status INTO v_status;
  IF v_status IS DISTINCT FROM 'done' THEN
    RAISE EXCEPTION 'FAIL 8: complete done update not applied (status %)', v_status;
  END IF;
  INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash,
                                         status, order_ref, response, completed_at)
  VALUES (v_user, v_key, 'bill', 'selftest-' || gen_random_uuid()::text, v_hash,
          'done', gen_random_uuid()::text, '{"status": "pending"}'::jsonb, now());
  -- unknown needs no order (ambiguous outcome).
  UPDATE public.api_v2_idempotency SET status = 'unknown', completed_at = now() WHERE id = v_bill;

  -- 9. A no-charge release (DELETE) frees the reference ----------------------
  DELETE FROM public.api_v2_idempotency WHERE id = v_bill;
  v_bill := NULL;
  INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
  VALUES (v_user, v_key, 'bill', v_ref, v_hash2)
  RETURNING id INTO v_bill;
  IF v_bill IS NULL THEN
    RAISE EXCEPTION 'FAIL 9: re-claim after release returned no id';
  END IF;

  -- 10. Foreign keys -----------------------------------------------------------
  <<fk_key>>
  BEGIN
    INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
    VALUES (v_user, gen_random_uuid(), 'airtime', 'selftest-' || gen_random_uuid()::text, v_hash);
    RAISE EXCEPTION 'FAIL 10: claim with an unknown key accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END fk_key;
  <<fk_user>>
  BEGIN
    INSERT INTO public.api_v2_idempotency (user_id, api_v2_key_id, kind, reference, request_hash)
    VALUES (gen_random_uuid(), v_key, 'airtime', 'selftest-' || gen_random_uuid()::text, v_hash);
    RAISE EXCEPTION 'FAIL 10: claim with an unknown user accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END fk_user;
  -- A key with claims cannot be deleted on its own (NO ACTION).
  <<fk_key_delete>>
  BEGIN
    DELETE FROM public.api_v2_keys WHERE id = v_key;
    RAISE EXCEPTION 'FAIL 10: key with claims was deleted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END fk_key_delete;

  -- Always roll back. -------------------------------------------------------
  RAISE EXCEPTION 'SELFTEST_OK 0132: all scenarios passed; rolling back';
END $selftest$;
