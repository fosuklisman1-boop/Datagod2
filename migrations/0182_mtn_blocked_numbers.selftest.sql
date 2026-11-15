-- 0182_mtn_blocked_numbers.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0182_mtn_blocked_numbers.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as lib/blocked-numbers/migration-0182.test.ts does:
--   1. 0182_mtn_blocked_numbers.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: every sub-block is labelled and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so both tables and EVERY test row
-- are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send `ROLLBACK;`.
--
-- Scenarios (labels): catalog, grants, check, cascade.

DO $selftest$
DECLARE
  v_t      text;
  v_p      text;
  v_i      text;
  v_n      int;
  v_ok     boolean;
  v_id     uuid;
BEGIN
  -- catalog: both tables exist, RLS on, zero policies, every index present -------------------------
  FOREACH v_t IN ARRAY ARRAY['mtn_blocked_numbers', 'mtn_blocked_attempts'] LOOP
    SELECT count(*) INTO v_n FROM pg_class WHERE oid = to_regclass('public.' || v_t) AND relrowsecurity;
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: % missing or RLS is off', v_t; END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL catalog: % has % policies', v_t, v_n; END IF;
  END LOOP;
  FOREACH v_i IN ARRAY ARRAY[
    'mtn_blocked_numbers_recheck_idx', 'mtn_blocked_numbers_notify_idx', 'mtn_blocked_numbers_shop_idx',
    'mtn_blocked_numbers_notify_phone_idx', 'mtn_blocked_attempts_shop_idx', 'mtn_blocked_attempts_user_idx',
    'mtn_blocked_attempts_phone_idx', 'mtn_blocked_attempts_created_idx', 'mtn_blocked_attempts_number_idx'] LOOP
    SELECT count(*) INTO v_n FROM pg_indexes WHERE schemaname = 'public' AND indexname = v_i;
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: index % missing', v_i; END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'mtn_blocked_numbers_recheck_idx'
     AND indexdef LIKE '%(status, next_recheck_at)%' AND indexdef LIKE '%WHERE (status = ''blocked''%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: recheck index is not the partial (status, next_recheck_at)'; END IF;
  SELECT count(*) INTO v_n FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'mtn_blocked_numbers_notify_idx'
     AND indexdef LIKE '%(status, customer_notified_at)%' AND indexdef LIKE '%WHERE (status = ''allowed''%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: notify index is not the partial (status, customer_notified_at)'; END IF;

  -- grants: nothing for anon or authenticated; service_role SELECT, INSERT, UPDATE, DELETE -----------
  FOREACH v_t IN ARRAY ARRAY['mtn_blocked_numbers', 'mtn_blocked_attempts'] LOOP
    FOREACH v_p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege('anon', 'public.' || v_t, v_p) OR has_table_privilege('authenticated', 'public.' || v_t, v_p) THEN
        RAISE EXCEPTION 'FAIL grants: anon or authenticated has % on %', v_p, v_t;
      END IF;
      IF v_p = 'TRUNCATE' AND has_table_privilege('service_role', 'public.' || v_t, v_p) THEN
        RAISE EXCEPTION 'FAIL grants: service_role has TRUNCATE on %', v_t;
      END IF;
      IF v_p <> 'TRUNCATE' AND NOT has_table_privilege('service_role', 'public.' || v_t, v_p) THEN
        RAISE EXCEPTION 'FAIL grants: service_role lacks % on %', v_p, v_t;
      END IF;
    END LOOP;
  END LOOP;

  -- check: defaults work; a bad status and a bad surface are refused ------------------------------
  INSERT INTO public.mtn_blocked_numbers (phone) VALUES ('0200000601') RETURNING id INTO v_id;
  SELECT count(*) INTO v_n FROM public.mtn_blocked_numbers
   WHERE id = v_id AND status = 'blocked' AND attempts = 1 AND recheck_count = 0 AND notify_attempts = 0
     AND ready_sms_count = 0 AND ready_sms_window_start IS NULL AND providers_rejected = '{}';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL check: column defaults are wrong'; END IF;
  FOREACH v_p IN ARRAY ARRAY['blocked', 'allowed', 'expired', 'handled'] LOOP
    UPDATE public.mtn_blocked_numbers SET status = v_p WHERE id = v_id;
  END LOOP;
  FOREACH v_p IN ARRAY ARRAY['storefront', 'storefront_preview', 'dashboard', 'dashboard_preview', 'dashboard_bulk',
                             'dashboard_bulk_preview', 'api_v1', 'api_v2', 'ussd_hubtel', 'ussd_hubtel_shop', 'ussd_uzo',
                             'ussd_uzo_shop', 'whatsapp_shop', 'whatsapp_ai', 'text_to_buy', 'text_to_buy_airtime', 'unknown'] LOOP
    INSERT INTO public.mtn_blocked_attempts (blocked_number_id, phone, surface) VALUES (v_id, '0200000601', v_p);
  END LOOP;
  v_ok := false;
  <<bad_status>>
  BEGIN
    UPDATE public.mtn_blocked_numbers SET status = 'bogus' WHERE id = v_id;
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END bad_status;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL check: an unknown status was accepted'; END IF;
  v_ok := false;
  <<bad_surface>>
  BEGIN
    INSERT INTO public.mtn_blocked_attempts (blocked_number_id, phone, surface) VALUES (v_id, '0200000601', 'bogus');
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END bad_surface;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL check: an unknown surface was accepted'; END IF;

  -- cascade: deleting a number deletes its attempts ----------------------------------------------
  SELECT count(*) INTO v_n FROM public.mtn_blocked_attempts WHERE blocked_number_id = v_id;
  IF v_n <> 17 THEN RAISE EXCEPTION 'FAIL cascade: % attempts before delete (want 17)', v_n; END IF;
  DELETE FROM public.mtn_blocked_numbers WHERE id = v_id;
  SELECT count(*) INTO v_n FROM public.mtn_blocked_attempts WHERE blocked_number_id = v_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL cascade: % attempts survived the delete', v_n; END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0182 blocked numbers tables, grants, checks and cascade';
END $selftest$;
