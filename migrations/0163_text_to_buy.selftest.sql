-- 0163_text_to_buy.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0163_text_to_buy.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as lib/text-to-buy/migration-0163.test.ts does:
--   1. 0163_text_to_buy.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: every sub-block is labelled and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the tables, the settings rows
-- and every test row are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error
-- means it failed. If the client keeps the session open, send `ROLLBACK;`.
--
-- Scenarios (labels): catalog, grants, deny_anon / deny_authenticated, settings_defaults, one_open_order, dedupe, counts,
-- overview, purge, fn_grants. Uses sender numbers 0200000101-0200000199 only; touches no real user or order.

DO $selftest$
DECLARE
  v_tables CONSTANT text[] := ARRAY['ttb_messages','ttb_conversations','ttb_orders','ttb_blocked','ttb_heartbeat'];
  v_funcs  CONSTANT text[] := ARRAY['public.ttb_counts(text,text,timestamptz)','public.ttb_global_prompts(timestamptz)',
                                    'public.ttb_overview(timestamptz)','public.ttb_purge(timestamptz)'];
  v_t      text;
  v_p      text;
  v_bad    text;
  v_n      int;
  v_ok     boolean;
  v_r      record;
BEGIN
  -- catalog: RLS on, no policies ----------------------------------------------------
  FOREACH v_t IN ARRAY v_tables LOOP
    SELECT count(*) INTO v_n FROM pg_class WHERE oid = to_regclass('public.' || v_t) AND relrowsecurity;
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: % missing or RLS is off', v_t; END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL catalog: % has % policies', v_t, v_n; END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_constraint WHERE contype = 'f' AND conrelid = 'public.ttb_orders'::regclass;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL catalog: ttb_orders has a foreign key'; END IF;

  -- grants: nothing for anon or authenticated; service_role never TRUNCATE, never DELETE on messages or orders ----
  FOREACH v_t IN ARRAY v_tables LOOP
    FOREACH v_p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
      IF has_table_privilege('anon', 'public.' || v_t, v_p) OR has_table_privilege('authenticated', 'public.' || v_t, v_p) THEN
        RAISE EXCEPTION 'FAIL grants: anon or authenticated has % on %', v_p, v_t;
      END IF;
      IF v_p = 'TRUNCATE' AND has_table_privilege('service_role', 'public.' || v_t, v_p) THEN
        RAISE EXCEPTION 'FAIL grants: service_role has TRUNCATE on %', v_t;
      END IF;
    END LOOP;
    IF v_t IN ('ttb_messages', 'ttb_orders') AND has_table_privilege('service_role', 'public.' || v_t, 'DELETE') THEN
      RAISE EXCEPTION 'FAIL grants: service_role has DELETE on %', v_t;
    END IF;
  END LOOP;

  -- deny_anon / deny_authenticated: a real read under each role is refused ----------------
  FOREACH v_bad IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH v_t IN ARRAY v_tables LOOP
      v_ok := false;
      <<deny>>
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', v_bad);
        EXECUTE format('SELECT count(*) FROM public.%I', v_t) INTO v_n;
      EXCEPTION WHEN insufficient_privilege THEN
        v_ok := true;
      END deny;
      RESET ROLE;
      IF NOT v_ok THEN RAISE EXCEPTION 'FAIL deny_%: % could read %', v_bad, v_bad, v_t; END IF;
    END LOOP;
  END LOOP;

  -- settings_defaults ---------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.admin_settings WHERE key LIKE 'ttb\_%';
  IF v_n <> 12 THEN RAISE EXCEPTION 'FAIL settings_defaults: % of 12 keys', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.admin_settings WHERE key = 'ttb_main_enabled' AND value = '{"value": false}'::jsonb;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL settings_defaults: ttb_main_enabled is not {"value": false}'; END IF;

  -- one_open_order: a second awaiting_payment for the same (line, sender) is refused; a closed one is not -------
  INSERT INTO public.ttb_orders (line, sender, order_id, size, recipient, gift, amount)
  VALUES ('main', '0200000101', gen_random_uuid(), '1GB', '0200000150', false, 5);
  v_ok := false;
  <<second_open>>
  BEGIN
    INSERT INTO public.ttb_orders (line, sender, order_id, size, recipient, gift, amount)
    VALUES ('main', '0200000101', gen_random_uuid(), '1GB', '0200000150', false, 5);
  EXCEPTION WHEN unique_violation THEN
    v_ok := true;
  END second_open;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL one_open_order: two awaiting_payment orders were accepted'; END IF;
  INSERT INTO public.ttb_orders (line, sender, order_id, state, size, recipient, gift, amount, notices, paid_at, delivered_at)
  VALUES ('main', '0200000101', gen_random_uuid(), 'closed', '1GB', '0200000150', false, 5, ARRAY['delivered'], now(), now());

  -- dedupe: a duplicate dedupe_key is refused ---------------------------------------------
  INSERT INTO public.ttb_messages (line, sender, direction, body, dedupe_key, read_by, outcome)
  VALUES ('main', '0200000101', 'in', 'selftest', 'selftest-key', 'ai', 'not_order');
  v_ok := false;
  <<dup_key>>
  BEGIN
    INSERT INTO public.ttb_messages (line, sender, direction, body, dedupe_key) VALUES ('main', '0200000101', 'in', 'selftest', 'selftest-key');
  EXCEPTION WHEN unique_violation THEN
    v_ok := true;
  END dup_key;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL dedupe: a duplicate dedupe_key was accepted'; END IF;
  INSERT INTO public.ttb_messages (line, sender, direction, body) VALUES ('main', '0200000101', 'out', 'selftest');

  -- counts ----------------------------------------------------------------------------
  SELECT * INTO v_r FROM public.ttb_counts('main', '0200000101', now() - interval '1 hour');
  IF v_r.prompts_unpaid <> 1 OR v_r.replies <> 1 OR v_r.ai_reads <> 1 OR v_r.not_understood <> 1 THEN
    RAISE EXCEPTION 'FAIL counts: % / % / % / %', v_r.prompts_unpaid, v_r.replies, v_r.ai_reads, v_r.not_understood;
  END IF;
  SELECT * INTO v_r FROM public.ttb_counts('main', '0200000101', now() + interval '1 hour');
  IF v_r.prompts_unpaid <> 0 OR v_r.replies <> 0 OR v_r.ai_reads <> 0 OR v_r.not_understood <> 0 THEN
    RAISE EXCEPTION 'FAIL counts: rows before p_since were counted';
  END IF;
  IF public.ttb_global_prompts(now() - interval '1 hour') <> 2 THEN RAISE EXCEPTION 'FAIL counts: global prompts'; END IF;

  -- overview: both lines; paid and delivered come from paid_at / delivered_at -----------------
  SELECT count(*) INTO v_n FROM public.ttb_overview(now() - interval '1 hour');
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL overview: % rows', v_n; END IF;
  SELECT * INTO v_r FROM public.ttb_overview(now() - interval '1 hour') o WHERE o.line = 'main';
  IF v_r.texts <> 1 OR v_r.prompts <> 2 OR v_r.paid <> 1 OR v_r.delivered <> 1 OR v_r.replies <> 1 OR v_r.ai_reads <> 1 OR v_r.rule_reads <> 0 THEN
    RAISE EXCEPTION 'FAIL overview: main row is wrong';
  END IF;

  -- purge: old messages and expired conversations go; orders stay ---------------------------
  INSERT INTO public.ttb_conversations (line, sender, expires_at) VALUES ('main', '0200000102', now() - interval '1 day');
  IF public.ttb_purge(now() + interval '1 hour') <> 3 THEN RAISE EXCEPTION 'FAIL purge: wrong count'; END IF;
  SELECT count(*) INTO v_n FROM public.ttb_orders;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL purge: orders were touched'; END IF;

  -- fn_grants: service_role only ----------------------------------------------------------
  FOREACH v_t IN ARRAY v_funcs LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') OR has_function_privilege('authenticated', v_t, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL fn_grants: anon or authenticated can execute %', v_t;
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.oid = v_t::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE';
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL fn_grants: PUBLIC can execute %', v_t; END IF;
    IF NOT has_function_privilege('service_role', v_t, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL fn_grants: service_role cannot execute %', v_t; END IF;
  END LOOP;

  RAISE EXCEPTION 'SELFTEST_OK 0163 tables, grants, settings, constraints and functions';
END $selftest$;
