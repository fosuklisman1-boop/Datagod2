-- 0195_api_approval.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0195_api_approval.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no transaction-ending word and that this DO
-- block has no bare end statement and finishes by raising. (The 0130 incident lesson.) Build it as
-- lib/api-v2/migration-0195-run.ts does:
--   1. 0195_api_approval.sql with BEGIN kept (and both SET LOCALs) and ONLY its final transaction-ending line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare end statement: nested blocks are labelled and the block closes with the $selftest$ tag.
--
-- The DO block always finishes with RAISE EXCEPTION, which ends the explicit transaction whatever the client does, so the new
-- tables, indexes and functions and every throwaway row below are undone. PASSES when the error text starts with
-- 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed. If the client keeps the session open, send the
-- transaction-ending statement for an aborted transaction yourself. After the real apply the DO block can also be run
-- alone inside BEGIN (never ended with a commit).
--
-- Production safety: it never changes an existing row. The foreign key api_v2_keys.user_id -> auth.users is satisfied by
-- picking existing, non-suspended users that have no api_v2_keys, grants or requests rows at all (so the throwaway keys
-- cannot collide with a real slot) and only INSERTING rows that point at them. Throwaway keys use key_hash 'selftest-' || uuid.
-- Optional checks (not_eligible, suspended) run only when a suitable existing user is found; otherwise they are skipped
-- (the PGlite suite covers them). The actor is a random uuid: admin_audit_log has no foreign keys since 0176.
--
-- What it cannot cover: true two-session races. Those rely on the FOR UPDATE slot lock and the re-read in a fresh statement
-- (see the migration header). One session cannot exercise the wait.

DO $selftest$
DECLARE
  v_actor  uuid := gen_random_uuid();
  v_u      uuid;
  v_u2     uuid;
  v_u3     uuid;
  v_a      uuid;
  v_p      uuid;
  v_p2     uuid;
  v_p3     uuid;
  v_a2     uuid;
  v_req    uuid;
  v_req2   uuid;
  v_r      jsonb;
  v_t      text;
  v_who    text;
  v_fn     text;
  v_n      int;
  v_code   text;
  v_allowed text[];
BEGIN
  -- Schema ------------------------------------------------------------------
  FOREACH v_t IN ARRAY ARRAY['api_v2_access_requests', 'api_v2_access_grants'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN RAISE EXCEPTION 'FAIL table_missing %', v_t; END IF;
    IF NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass), false) THEN
      RAISE EXCEPTION 'FAIL rls_not_enabled %', v_t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t) THEN
      RAISE EXCEPTION 'FAIL table_has_policy %', v_t;
    END IF;
    FOREACH v_who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(v_who, 'public.' || v_t, 'SELECT') OR has_table_privilege(v_who, 'public.' || v_t, 'INSERT')
         OR has_table_privilege(v_who, 'public.' || v_t, 'UPDATE') OR has_table_privilege(v_who, 'public.' || v_t, 'DELETE') THEN
        RAISE EXCEPTION 'FAIL client_role_has_privilege % %', v_who, v_t;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', 'public.' || v_t, 'INSERT') THEN
      RAISE EXCEPTION 'FAIL service_role_lacks_privilege %', v_t;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.api_v2_approve_key(uuid,uuid)', 'public.api_v2_reject_key(uuid,uuid,text)',
    'public.api_v2_approve_access(uuid,uuid)', 'public.api_v2_reject_access(uuid,uuid,text)',
    'public.api_v2_remove_grant(uuid,uuid,text)', 'public.api_v2_approval_context(uuid[])',
    'public.api_v2_new_request_code()'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN RAISE EXCEPTION 'FAIL function_missing %', v_fn; END IF;
    FOREACH v_who IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      IF has_function_privilege(v_who, v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL client_can_execute % %', v_who, v_fn; END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL service_role_cannot_execute %', v_fn; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(v_fn)) THEN RAISE EXCEPTION 'FAIL not_security_definer %', v_fn; END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'api_v2_keys_one_live_per_type') THEN
    RAISE EXCEPTION 'FAIL old_index_still_present';
  END IF;
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND indexname IN ('api_v2_keys_one_active_per_slot', 'api_v2_keys_one_pending_per_slot');
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL new_indexes_missing %', v_n; END IF;
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'api_v2_keys' AND column_name IN ('request_code', 'rejected_at', 'rejected_by', 'reject_reason'))
       OR (table_name = 'api_v2_config' AND column_name = 'approval_whatsapp')
       OR (table_name = 'api_v2_logs' AND column_name = 'error_reason'));
  IF v_n <> 6 THEN RAISE EXCEPTION 'FAIL columns_missing %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.api_v2_keys WHERE environment = 'live' AND status = 'pending' AND request_code IS NULL) THEN
    RAISE EXCEPTION 'FAIL backfill_incomplete';
  END IF;
  IF EXISTS (SELECT 1 FROM public.api_v2_keys WHERE request_code IS NOT NULL AND request_code !~ '^API-[2-9A-HJKMNP-Z]{6}$') THEN
    RAISE EXCEPTION 'FAIL bad_code_shape';
  END IF;
  v_code := public.api_v2_new_request_code();
  IF v_code !~ '^API-[2-9A-HJKMNP-Z]{6}$' THEN RAISE EXCEPTION 'FAIL bad_new_code %', v_code; END IF;

  -- Setup: existing users that have no api_v2 rows at all (nothing of theirs is changed) -----------------------------
  SELECT u.id INTO v_u
    FROM public.users u JOIN auth.users au ON au.id = u.id
   WHERE coalesce(u.is_suspended, false) = false
     AND NOT EXISTS (SELECT 1 FROM public.api_v2_keys k WHERE k.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.api_v2_access_grants g WHERE g.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.api_v2_access_requests r WHERE r.user_id = u.id)
   ORDER BY u.id LIMIT 1;
  IF v_u IS NULL THEN RAISE EXCEPTION 'FAIL setup: no existing unsuspended user without api_v2 rows'; END IF;

  -- Approve key: grant makes the user eligible whatever the role ----------------------------------------------------
  INSERT INTO public.api_v2_access_grants (user_id, granted_by) VALUES (v_u, v_actor);
  INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix, rate_limits)
  VALUES (v_u, 'standard', 'live', 'active', 'selftest 0195', 'selftest-' || gen_random_uuid()::text, 'selftest', '{"purchase": 50}'::jsonb)
  RETURNING id INTO v_a;
  INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix, request_code)
  VALUES (v_u, 'standard', 'live', 'pending', 'selftest 0195', 'selftest-' || gen_random_uuid()::text, 'selftest', public.api_v2_new_request_code())
  RETURNING id INTO v_p;

  <<b_nullactor>>
  BEGIN
    PERFORM public.api_v2_approve_key(v_p, NULL);
    RAISE EXCEPTION 'FAIL null_actor_accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'actor is required' THEN RAISE EXCEPTION 'FAIL null_actor_wrong_error %', SQLERRM; END IF;
  END b_nullactor;

  v_r := public.api_v2_approve_key(v_p, v_actor);
  IF v_r IS DISTINCT FROM jsonb_build_object('ok', true, 'user_id', v_u, 'key_type', 'standard', 'replaced_key_id', v_a) THEN
    RAISE EXCEPTION 'FAIL approve_key %', v_r;
  END IF;
  IF (SELECT status FROM public.api_v2_keys WHERE id = v_a) <> 'revoked' THEN RAISE EXCEPTION 'FAIL old_key_not_revoked'; END IF;
  IF (SELECT status FROM public.api_v2_keys WHERE id = v_p) <> 'active' THEN RAISE EXCEPTION 'FAIL new_key_not_active'; END IF;
  IF (SELECT rate_limits FROM public.api_v2_keys WHERE id = v_p) IS DISTINCT FROM '{"purchase": 50}'::jsonb THEN
    RAISE EXCEPTION 'FAIL limits_not_copied';
  END IF;
  v_r := public.api_v2_approve_key(v_p, v_actor);
  IF v_r IS DISTINCT FROM '{"ok": false, "code": "stale"}'::jsonb THEN RAISE EXCEPTION 'FAIL approve_twice %', v_r; END IF;

  -- Reject key: the active key is untouched ---------------------------------------------------------------------------
  INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix, request_code)
  VALUES (v_u, 'standard', 'live', 'pending', 'selftest 0195', 'selftest-' || gen_random_uuid()::text, 'selftest', public.api_v2_new_request_code())
  RETURNING id INTO v_p2;
  v_r := public.api_v2_reject_key(v_p2, v_actor, 'ab');
  IF v_r IS DISTINCT FROM '{"ok": false, "code": "bad_reason"}'::jsonb THEN RAISE EXCEPTION 'FAIL reject_short_reason %', v_r; END IF;
  v_r := public.api_v2_reject_key(v_p2, v_actor, repeat('x', 201));
  IF v_r IS DISTINCT FROM '{"ok": false, "code": "bad_reason"}'::jsonb THEN RAISE EXCEPTION 'FAIL reject_long_reason %', v_r; END IF;
  v_r := public.api_v2_reject_key(v_p2, v_actor, 'Not verified');
  IF v_r IS DISTINCT FROM jsonb_build_object('ok', true, 'user_id', v_u, 'key_type', 'standard') THEN RAISE EXCEPTION 'FAIL reject_key %', v_r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.api_v2_keys WHERE id = v_p2 AND status = 'revoked' AND rejected_at IS NOT NULL
                   AND rejected_by = v_actor AND reject_reason = 'Not verified') THEN
    RAISE EXCEPTION 'FAIL rejected_key_fields';
  END IF;
  IF (SELECT status FROM public.api_v2_keys WHERE id = v_p) <> 'active' THEN RAISE EXCEPTION 'FAIL reject_touched_active'; END IF;

  -- Slot indexes: a second pending in one slot is refused (23505) ------------------------------------------------------
  INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix)
  VALUES (v_u, 'standard', 'live', 'pending', 'selftest 0195', 'selftest-' || gen_random_uuid()::text, 'selftest')
  RETURNING id INTO v_p3;
  <<b_dup>>
  BEGIN
    INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix)
    VALUES (v_u, 'standard', 'live', 'pending', 'selftest 0195', 'selftest-' || gen_random_uuid()::text, 'selftest');
    RAISE EXCEPTION 'FAIL second_pending_allowed';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END b_dup;
  UPDATE public.api_v2_keys SET status = 'revoked' WHERE id = v_p3; -- throwaway row of our own

  -- Grants and access requests ----------------------------------------------------------------------------------------
  v_r := public.api_v2_remove_grant(v_u, v_actor, 'Selftest removal');
  IF v_r IS DISTINCT FROM jsonb_build_object('ok', true, 'user_id', v_u) THEN RAISE EXCEPTION 'FAIL remove_grant %', v_r; END IF;
  v_r := public.api_v2_remove_grant(v_u, v_actor, 'Selftest removal');
  IF v_r IS DISTINCT FROM '{"ok": false, "code": "not_found"}'::jsonb THEN RAISE EXCEPTION 'FAIL remove_grant_twice %', v_r; END IF;
  IF (SELECT status FROM public.api_v2_keys WHERE id = v_p) <> 'active' THEN RAISE EXCEPTION 'FAIL remove_grant_touched_key'; END IF;

  INSERT INTO public.api_v2_access_requests (user_id, request_code, reason)
  VALUES (v_u, public.api_v2_new_request_code(), 'selftest') RETURNING id INTO v_req;
  SELECT count(*) INTO v_n FROM public.api_v2_keys WHERE user_id = v_u;
  v_r := public.api_v2_approve_access(v_req, v_actor);
  IF v_r IS DISTINCT FROM jsonb_build_object('ok', true, 'user_id', v_u) THEN RAISE EXCEPTION 'FAIL approve_access %', v_r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.api_v2_access_grants WHERE user_id = v_u AND request_id = v_req) THEN RAISE EXCEPTION 'FAIL grant_not_inserted'; END IF;
  IF (SELECT count(*) FROM public.api_v2_keys WHERE user_id = v_u) <> v_n THEN RAISE EXCEPTION 'FAIL approve_access_created_key'; END IF;
  v_r := public.api_v2_approve_access(v_req, v_actor);
  IF v_r IS DISTINCT FROM '{"ok": false, "code": "stale"}'::jsonb THEN RAISE EXCEPTION 'FAIL approve_access_twice %', v_r; END IF;

  INSERT INTO public.api_v2_access_requests (user_id, request_code, reason)
  VALUES (v_u, public.api_v2_new_request_code(), 'selftest') RETURNING id INTO v_req2;
  v_r := public.api_v2_reject_access(v_req2, v_actor, 'no');
  IF v_r IS DISTINCT FROM '{"ok": false, "code": "bad_reason"}'::jsonb THEN RAISE EXCEPTION 'FAIL reject_access_reason %', v_r; END IF;
  v_r := public.api_v2_reject_access(v_req2, v_actor, 'Selftest rejection');
  IF v_r IS DISTINCT FROM jsonb_build_object('ok', true, 'user_id', v_u) THEN RAISE EXCEPTION 'FAIL reject_access %', v_r; END IF;
  v_r := public.api_v2_remove_grant(v_u, v_actor, 'Selftest removal');
  IF (v_r->>'ok')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL remove_grant_2 %', v_r; END IF;

  -- Audit: one row per success (approve_key, reject_key, remove_grant, approve_access, reject_access, remove_grant), none for failures
  SELECT count(*) INTO v_n FROM public.admin_audit_log WHERE admin_id = v_actor AND target_user_id = v_u;
  IF v_n <> 6 THEN RAISE EXCEPTION 'FAIL audit_rows %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.admin_audit_log WHERE admin_id = v_actor
               AND action NOT IN ('api_key_approve', 'api_key_reject', 'api_access_approve', 'api_access_reject', 'api_grant_remove')) THEN
    RAISE EXCEPTION 'FAIL audit_action_name';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_audit_log WHERE admin_id = v_actor
               AND (coalesce(old_value::text, '') || coalesce(new_value::text, '')) ~* 'key_hash|key_prefix|phone|selftest-') THEN
    RAISE EXCEPTION 'FAIL audit_leaks_secret';
  END IF;

  -- Context (read only) -----------------------------------------------------------------------------------------------
  v_r := public.api_v2_approval_context(ARRAY[v_u]);
  IF jsonb_typeof(v_r -> v_u::text -> 'topups_30d') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_r -> v_u::text -> 'orders_30d') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'FAIL approval_context_shape %', v_r;
  END IF;
  IF public.api_v2_approval_context(NULL) IS DISTINCT FROM '{}'::jsonb THEN RAISE EXCEPTION 'FAIL approval_context_null'; END IF;

  -- Optional: not eligible (existing user whose role is not allowed and who has no api_v2 rows) -------------------------
  SELECT c.allowed_roles INTO v_allowed FROM public.api_v2_config c WHERE c.id;
  SELECT u.id INTO v_u2
    FROM public.users u JOIN auth.users au ON au.id = u.id
   WHERE coalesce(u.is_suspended, false) = false
     AND u.id <> v_u
     AND NOT (coalesce(u.role = ANY (coalesce(v_allowed, '{}'::text[])), false))
     AND NOT EXISTS (SELECT 1 FROM public.api_v2_keys k WHERE k.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.api_v2_access_grants g WHERE g.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.api_v2_access_requests r WHERE r.user_id = u.id)
   ORDER BY u.id LIMIT 1;
  IF v_u2 IS NOT NULL THEN
    INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix)
    VALUES (v_u2, 'standard', 'live', 'active', 'selftest 0195', 'selftest-' || gen_random_uuid()::text, 'selftest') RETURNING id INTO v_a2;
    INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix)
    VALUES (v_u2, 'standard', 'live', 'pending', 'selftest 0195', 'selftest-' || gen_random_uuid()::text, 'selftest') RETURNING id INTO v_p3;
    v_r := public.api_v2_approve_key(v_p3, v_actor);
    IF v_r IS DISTINCT FROM '{"ok": false, "code": "not_eligible"}'::jsonb THEN RAISE EXCEPTION 'FAIL not_eligible %', v_r; END IF;
    IF (SELECT status FROM public.api_v2_keys WHERE id = v_a2) <> 'active' THEN RAISE EXCEPTION 'FAIL not_eligible_touched_old'; END IF;
    IF (SELECT status FROM public.api_v2_keys WHERE id = v_p3) <> 'pending' THEN RAISE EXCEPTION 'FAIL not_eligible_touched_new'; END IF;
  END IF;

  -- Optional: suspended (an existing suspended user with no api_v2 rows) -------------------------------------------------
  SELECT u.id INTO v_u3
    FROM public.users u JOIN auth.users au ON au.id = u.id
   WHERE coalesce(u.is_suspended, false) = true
     AND NOT EXISTS (SELECT 1 FROM public.api_v2_keys k WHERE k.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.api_v2_access_grants g WHERE g.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.api_v2_access_requests r WHERE r.user_id = u.id)
   ORDER BY u.id LIMIT 1;
  IF v_u3 IS NOT NULL THEN
    INSERT INTO public.api_v2_keys (user_id, key_type, environment, status, name, key_hash, key_prefix)
    VALUES (v_u3, 'standard', 'live', 'pending', 'selftest 0195', 'selftest-' || gen_random_uuid()::text, 'selftest') RETURNING id INTO v_p3;
    v_r := public.api_v2_approve_key(v_p3, v_actor);
    IF v_r IS DISTINCT FROM '{"ok": false, "code": "suspended"}'::jsonb THEN RAISE EXCEPTION 'FAIL suspended %', v_r; END IF;
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0195';
END $selftest$;
