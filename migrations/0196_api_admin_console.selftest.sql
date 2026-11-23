-- 0196_api_admin_console.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0196_api_admin_console.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no transaction-ending word and that this DO
-- block has no bare end statement and finishes by raising. (The 0130 incident lesson.) Build it as
-- lib/api-v2/migration-0196-run.ts does:
--   1. 0196_api_admin_console.sql with BEGIN kept (and both SET LOCALs) and ONLY its final transaction-ending line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare end statement: nested blocks are labelled and the block closes with the $selftest$ tag.
--
-- The DO block always finishes with RAISE EXCEPTION, which ends the explicit transaction whatever the client does, so the new
-- tables, seeds and functions and every throwaway row below are undone. PASSES when the error text starts with
-- 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed. If the client keeps the session open, send the
-- transaction-ending statement for an aborted transaction yourself. After the real apply the DO block can also be run
-- alone inside BEGIN (never ended with a commit).
--
-- Production safety: it modifies no existing row that survives. It only INSERTS throwaway rows (pause row, announcements,
-- audit rows under a random actor uuid; the foreign key of the pause row is satisfied by an existing user) and calls the
-- read functions. The one existing row it touches is a seeded api_v2_service_controls row ('sms'), which the service-pause
-- step updates inside the always-ended transaction: in the dry run before the apply that row was created in the same
-- transaction; if the block is run alone after the apply, the row is locked for the few milliseconds the block takes (readers are
-- never blocked) and the end of the transaction restores it. A real pause of 'sms' is restored too.
-- Optional checks (the developer pause steps, the profile check) run only when a suitable existing user or key is found;
-- otherwise they are skipped (the PGlite suite covers them). The comparisons against live data (profile totals against
-- api_v2_key_activity, report revenue against api_v2_admin_stats) are retried up to three times because live traffic can
-- arrive between the two calls.
--
-- What it cannot cover: true two-session races (the 50-row cap advisory lock, the row locks). One session cannot exercise a wait.

DO $selftest$
DECLARE
  v_actor  uuid := gen_random_uuid();
  v_u      uuid;
  v_email  text;
  v_ku     uuid;
  v_r      jsonb;
  v_prof   jsonb;
  v_stats  jsonb;
  v_id     uuid;
  v_t      text;
  v_fn     text;
  v_who    text;
  v_p      text;
  v_n      int;
  v_i      int;
  v_a      numeric;
  v_b      numeric;
  v_ok     boolean;
BEGIN
  -- Schema ------------------------------------------------------------------
  FOREACH v_t IN ARRAY ARRAY['api_v2_developer_pauses', 'api_v2_service_controls', 'api_v2_announcements'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN RAISE EXCEPTION 'FAIL table_missing %', v_t; END IF;
    IF NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass), false) THEN
      RAISE EXCEPTION 'FAIL rls_not_enabled %', v_t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t) THEN
      RAISE EXCEPTION 'FAIL table_has_policy %', v_t;
    END IF;
    FOREACH v_who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(v_who, 'public.' || v_t, v_p) THEN
          RAISE EXCEPTION 'FAIL client_role_has_privilege % % %', v_who, v_p, v_t;
        END IF;
      END LOOP;
    END LOOP;
    IF NOT has_table_privilege('service_role', 'public.' || v_t, 'INSERT') THEN
      RAISE EXCEPTION 'FAIL service_role_lacks_privilege %', v_t;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.api_v2_set_developer_pause(uuid,boolean,text,uuid)', 'public.api_v2_set_service_pause(text,boolean,text,uuid)',
    'public.api_v2_announcement_save(uuid,text,text,text,timestamptz,timestamptz,uuid)', 'public.api_v2_announcement_delete(uuid,uuid)',
    'public.api_v2_developers(timestamptz,text,integer,integer)', 'public.api_v2_developer_profile(uuid,timestamptz)',
    'public.api_v2_overview_trend(timestamptz)', 'public.api_v2_business_report(timestamptz,timestamptz)',
    'public.api_v2_public_health(timestamptz)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN RAISE EXCEPTION 'FAIL function_missing %', v_fn; END IF;
    FOREACH v_who IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      IF has_function_privilege(v_who, v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL client_can_execute % %', v_who, v_fn; END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL service_role_cannot_execute %', v_fn; END IF;
  END LOOP;

  -- Seeds and constraints ---------------------------------------------------
  IF (SELECT count(*) FROM public.api_v2_service_controls
       WHERE service IN ('data', 'airtime', 'bills', 'bundles', 'results', 'afa', 'sms')) <> 7 THEN
    RAISE EXCEPTION 'FAIL seed_rows_missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.api_v2_service_controls WHERE paused AND updated_by IS NULL) THEN
    RAISE EXCEPTION 'FAIL seed_row_paused_without_an_admin';
  END IF;
  <<chk_service_name>>
  BEGIN
    INSERT INTO public.api_v2_service_controls (service) VALUES ('selftest-unknown');
    RAISE EXCEPTION 'FAIL eighth_service_accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END chk_service_name;
  <<chk_message_len>>
  BEGIN
    UPDATE public.api_v2_service_controls SET message = repeat('x', 201) WHERE service = 'sms';
    RAISE EXCEPTION 'FAIL long_service_message_accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END chk_message_len;

  -- Actor is mandatory --------------------------------------------------------
  <<chk_actor>>
  BEGIN
    PERFORM public.api_v2_set_developer_pause(gen_random_uuid(), true, 'selftest reason', NULL);
    RAISE EXCEPTION 'FAIL null_actor_accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'actor is required' THEN RAISE EXCEPTION 'FAIL null_actor_wrong_error %', SQLERRM; END IF;
  END chk_actor;

  -- Developer pause (needs an existing user with an email) ----------------------
  v_r := public.api_v2_set_developer_pause(gen_random_uuid(), true, 'selftest reason', v_actor);
  IF v_r IS DISTINCT FROM '{"ok": false, "code": "not_found"}'::jsonb THEN RAISE EXCEPTION 'FAIL pause_unknown_user %', v_r; END IF;

  SELECT u.id, u.email INTO v_u, v_email
    FROM public.users u
   WHERE u.email IS NOT NULL AND char_length(u.email) BETWEEN 3 AND 60
     AND EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.api_v2_developer_pauses p WHERE p.user_id = u.id)
   ORDER BY u.id LIMIT 1;
  IF v_u IS NOT NULL THEN
    v_r := public.api_v2_set_developer_pause(v_u, true, 'ab', v_actor);
    IF v_r->>'code' IS DISTINCT FROM 'bad_reason' THEN RAISE EXCEPTION 'FAIL pause_short_reason %', v_r; END IF;
    v_r := public.api_v2_set_developer_pause(v_u, true, 'selftest pause', v_actor);
    IF NOT coalesce((v_r->>'ok')::boolean, false) OR NOT coalesce((v_r->>'changed')::boolean, false) THEN RAISE EXCEPTION 'FAIL pause %', v_r; END IF;
    v_r := public.api_v2_set_developer_pause(v_u, true, 'selftest pause again', v_actor);
    IF (v_r->>'changed')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL repause_changed %', v_r; END IF;
    SELECT count(*) INTO v_n FROM public.admin_audit_log WHERE admin_id = v_actor AND action = 'api_developer_pause' AND target_user_id = v_u;
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL pause_audit_rows %', v_n; END IF;
    v_r := public.api_v2_developers(NULL, v_email, 100, 0);
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'items') e WHERE e->>'user_id' = v_u::text AND (e->>'paused')::boolean) THEN
      RAISE EXCEPTION 'FAIL developers_list_misses_paused_user';
    END IF;
    v_prof := public.api_v2_developer_profile(v_u, NULL);
    IF v_prof IS NULL OR jsonb_typeof(v_prof->'pause') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'FAIL profile_misses_pause %', v_prof; END IF;
    IF v_prof::text LIKE '%key_hash%' THEN RAISE EXCEPTION 'FAIL profile_leaks_key_hash'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_prof->'orders') o WHERE o->>'recipient_phone' ~ '[0-9]{5}') THEN
      RAISE EXCEPTION 'FAIL profile_phone_not_masked';
    END IF;
    v_r := public.api_v2_set_developer_pause(v_u, false, NULL, v_actor);
    IF NOT coalesce((v_r->>'changed')::boolean, false) THEN RAISE EXCEPTION 'FAIL unpause %', v_r; END IF;
    IF EXISTS (SELECT 1 FROM public.api_v2_developer_pauses WHERE user_id = v_u) THEN RAISE EXCEPTION 'FAIL unpause_left_row'; END IF;
    v_r := public.api_v2_set_developer_pause(v_u, false, NULL, v_actor);
    IF (v_r->>'changed')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL reunpause_changed %', v_r; END IF;
    SELECT count(*) INTO v_n FROM public.admin_audit_log WHERE admin_id = v_actor AND action = 'api_developer_unpause' AND target_user_id = v_u;
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL unpause_audit_rows %', v_n; END IF;
  END IF;

  -- Service pause -------------------------------------------------------------
  v_r := public.api_v2_set_service_pause('sms', true, '  selftest message  ', v_actor);
  IF NOT coalesce((v_r->>'changed')::boolean, false) OR v_r->>'message' IS DISTINCT FROM 'selftest message' THEN
    RAISE EXCEPTION 'FAIL service_pause %', v_r;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit_log WHERE admin_id = v_actor AND action = 'api_service_pause';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL service_pause_audit_rows %', v_n; END IF;
  v_r := public.api_v2_set_service_pause('sms', true, 'selftest message', v_actor);
  IF (v_r->>'changed')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL service_repause_changed %', v_r; END IF;
  v_r := public.api_v2_set_service_pause('sms', true, E'line\nbreak', v_actor);
  IF v_r->>'code' IS DISTINCT FROM 'bad_message' THEN RAISE EXCEPTION 'FAIL service_control_char %', v_r; END IF;
  v_r := public.api_v2_set_service_pause('sms', true, repeat('x', 201), v_actor);
  IF v_r->>'code' IS DISTINCT FROM 'bad_message' THEN RAISE EXCEPTION 'FAIL service_long_message %', v_r; END IF;
  v_r := public.api_v2_set_service_pause('selftest-unknown', true, NULL, v_actor);
  IF v_r->>'code' IS DISTINCT FROM 'not_found' THEN RAISE EXCEPTION 'FAIL service_unknown %', v_r; END IF;
  v_r := public.api_v2_set_service_pause('sms', true, '   ', v_actor);
  IF NOT coalesce((v_r->>'changed')::boolean, false) OR v_r->'message' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL service_empty_message %', v_r;
  END IF;
  v_r := public.api_v2_set_service_pause('sms', false, 'ignored on resume', v_actor);
  IF NOT coalesce((v_r->>'changed')::boolean, false) OR v_r->'message' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL service_resume %', v_r;
  END IF;
  IF EXISTS (SELECT 1 FROM public.api_v2_service_controls WHERE service = 'sms' AND (paused OR message IS NOT NULL)) THEN
    RAISE EXCEPTION 'FAIL service_resume_left_state';
  END IF;
  v_r := public.api_v2_set_service_pause('sms', false, NULL, v_actor);
  IF (v_r->>'changed')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL service_reresume_changed %', v_r; END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit_log WHERE admin_id = v_actor AND action = 'api_service_resume';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL service_resume_audit_rows %', v_n; END IF;

  -- Announcements -------------------------------------------------------------
  v_r := public.api_v2_announcement_save(NULL, ' Selftest ', ' Body text. ', 'warning', now(), now() + interval '1 day', v_actor);
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'FAIL announcement_create %', v_r; END IF;
  v_id := (v_r->>'id')::uuid;
  IF (SELECT title FROM public.api_v2_announcements WHERE id = v_id) IS DISTINCT FROM 'Selftest' THEN RAISE EXCEPTION 'FAIL announcement_trim'; END IF;
  v_r := public.api_v2_announcement_save(v_id, 'Selftest 2', 'Body text.', 'critical', now(), now() + interval '1 day', v_actor);
  IF NOT coalesce((v_r->>'changed')::boolean, false) THEN RAISE EXCEPTION 'FAIL announcement_update %', v_r; END IF;
  v_r := public.api_v2_announcement_save(v_id, 'Selftest 2', 'Body text.', 'critical', now(), now() + interval '1 day', v_actor);
  IF (v_r->>'changed')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL announcement_noop_changed %', v_r; END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit_log WHERE admin_id = v_actor AND action = 'api_announcement_save';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL announcement_audit_rows %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.admin_audit_log WHERE admin_id = v_actor AND action = 'api_announcement_save'
                AND (coalesce(old_value::text, '') || coalesce(new_value::text, '')) LIKE '%Body text%') THEN
    RAISE EXCEPTION 'FAIL announcement_audit_holds_body';
  END IF;
  v_r := public.api_v2_announcement_save(NULL, 't', 'b', 'info', now(), now(), v_actor);
  IF v_r->>'code' IS DISTINCT FROM 'bad_input' THEN RAISE EXCEPTION 'FAIL announcement_ends_not_after_starts %', v_r; END IF;
  v_r := public.api_v2_announcement_save(NULL, repeat('x', 81), 'b', 'info', now(), now() + interval '1 day', v_actor);
  IF v_r->>'code' IS DISTINCT FROM 'bad_input' THEN RAISE EXCEPTION 'FAIL announcement_long_title %', v_r; END IF;
  v_r := public.api_v2_announcement_save(NULL, 't', 'b', 'boom', now(), now() + interval '1 day', v_actor);
  IF v_r->>'code' IS DISTINCT FROM 'bad_input' THEN RAISE EXCEPTION 'FAIL announcement_severity %', v_r; END IF;
  v_r := public.api_v2_announcement_save(gen_random_uuid(), 't', 'b', 'info', now(), now() + interval '1 day', v_actor);
  IF v_r->>'code' IS DISTINCT FROM 'not_found' THEN RAISE EXCEPTION 'FAIL announcement_unknown_id %', v_r; END IF;
  v_ok := false;
  FOR v_i IN 1..60 LOOP
    v_r := public.api_v2_announcement_save(NULL, 'selftest ' || v_i, 'b', 'info', now(), now() + interval '1 day', v_actor);
    IF NOT coalesce((v_r->>'ok')::boolean, false) THEN
      IF v_r->>'code' = 'too_many' THEN
        v_ok := true;
        EXIT;
      END IF;
      RAISE EXCEPTION 'FAIL announcement_loop %', v_r;
    END IF;
  END LOOP;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL announcement_cap_not_reached'; END IF;
  IF (SELECT count(*) FROM public.api_v2_announcements) <> 50 THEN RAISE EXCEPTION 'FAIL announcement_cap_not_50'; END IF;
  v_r := public.api_v2_announcement_delete(v_id, v_actor);
  IF NOT coalesce((v_r->>'changed')::boolean, false) THEN RAISE EXCEPTION 'FAIL announcement_delete %', v_r; END IF;
  v_r := public.api_v2_announcement_delete(v_id, v_actor);
  IF v_r->>'code' IS DISTINCT FROM 'not_found' THEN RAISE EXCEPTION 'FAIL announcement_delete_unknown %', v_r; END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit_log WHERE admin_id = v_actor AND action = 'api_announcement_delete';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL announcement_delete_audit_rows %', v_n; END IF;

  -- Read functions (shape, and invariants against live data) ----------------------
  v_r := public.api_v2_overview_trend(now() - interval '30 days');
  IF jsonb_typeof(v_r) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'FAIL trend_not_array %', v_r; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_r) e WHERE NOT (e ? 'day' AND e ? 'requests' AND e ? 'ok' AND e ? 'failed' AND e ? 'revenue')) THEN
    RAISE EXCEPTION 'FAIL trend_shape';
  END IF;

  v_r := public.api_v2_public_health(NULL);
  IF jsonb_typeof(v_r) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'FAIL health_not_array %', v_r; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_r) e WHERE e ?| ARRAY['user_id', 'key_id', 'ip_address', 'ip', 'environment']
                                                      OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 3) THEN
    RAISE EXCEPTION 'FAIL health_leaks_a_field';
  END IF;

  v_r := public.api_v2_developers(NULL, NULL, 1000, 0);
  IF jsonb_typeof(v_r->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(v_r->'items') > 100
     OR (v_r->>'total')::int < jsonb_array_length(v_r->'items') THEN
    RAISE EXCEPTION 'FAIL developers_shape';
  END IF;
  v_r := public.api_v2_developers(NULL, E'%_\\', 25, 0);
  IF jsonb_typeof(v_r->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'FAIL developers_search_shape'; END IF;

  SELECT k.user_id INTO v_ku FROM public.api_v2_keys k ORDER BY k.created_at, k.id LIMIT 1;
  IF v_ku IS NOT NULL THEN
    v_ok := false;
    FOR v_i IN 1..3 LOOP
      v_prof := public.api_v2_developer_profile(v_ku, now() - interval '30 days');
      SELECT coalesce(sum((public.api_v2_key_activity(k.id, now() - interval '30 days')->>'requests')::numeric), 0)
        INTO v_a FROM public.api_v2_keys k WHERE k.user_id = v_ku;
      v_ok := v_prof IS NOT NULL AND v_a = (v_prof->'totals'->>'requests')::numeric;
      EXIT WHEN v_ok;
    END LOOP;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL profile_totals_differ_from_key_activity'; END IF;
    IF jsonb_array_length(v_prof->'orders') > 20 THEN RAISE EXCEPTION 'FAIL profile_orders_over_20'; END IF;
    IF v_prof::text LIKE '%key_hash%' THEN RAISE EXCEPTION 'FAIL profile_leaks_key_hash'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_prof->'orders') o WHERE o->>'recipient_phone' ~ '[0-9]{5}') THEN
      RAISE EXCEPTION 'FAIL profile_phone_not_masked';
    END IF;
  END IF;

  v_ok := false;
  FOR v_i IN 1..3 LOOP
    v_r := public.api_v2_business_report(now() - interval '700 days', now() + interval '1 day');
    v_stats := public.api_v2_admin_stats(now() - interval '700 days');
    SELECT coalesce(sum((e->>'revenue')::numeric), 0), coalesce(sum((e->>'orders')::numeric), 0)
      INTO v_a, v_b FROM jsonb_array_elements(v_r) e;
    v_ok := abs(v_a - (v_stats->>'revenue')::numeric) < 0.005 AND v_b = (v_stats->>'orders')::numeric;
    EXIT WHEN v_ok;
  END LOOP;
  IF jsonb_typeof(v_r) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'FAIL report_not_array'; END IF;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL report_revenue_differs_from_admin_stats % %', v_a, v_stats->>'revenue'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_r) e WHERE (e->>'costed_orders')::int > (e->>'orders')::int
                                                     OR ((e->>'costed_orders')::int = 0 AND (e->>'cost_total')::numeric <> 0)) THEN
    RAISE EXCEPTION 'FAIL report_cost_columns_inconsistent';
  END IF;
  <<chk_range>>
  BEGIN
    PERFORM public.api_v2_business_report(now() - interval '1000 days', now());
    RAISE EXCEPTION 'FAIL oversized_range_accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'range too large' THEN RAISE EXCEPTION 'FAIL range_wrong_error %', SQLERRM; END IF;
  END chk_range;

  RAISE EXCEPTION 'SELFTEST_OK 0196';
END
$selftest$;
