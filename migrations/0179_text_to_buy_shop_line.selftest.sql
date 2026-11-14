-- 0179_text_to_buy_shop_line.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0179_text_to_buy_shop_line.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as lib/text-to-buy/migration-0179.test.ts does:
--   1. 0179_text_to_buy_shop_line.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: every sub-block is labelled and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new tables, the new columns,
-- the replaced ttb_purge and EVERY test row (including the test SMS account and its ledger rows) are rolled back. PASSES when
-- the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed. If the client keeps the session
-- open, send `ROLLBACK;`.
--
-- It needs 0177 applied (the ttb_ tables). The test SMS account borrows an auth.users id that has no SMS account yet (or, if
-- none is free, inserts a bare auth.users row) - all inside the rolled-back transaction, nothing real is touched or kept.
--
-- Scenarios (labels): catalog, grants, deny_anon / deny_authenticated, heartbeat, notice, reserve, race, draw, release,
-- reply, purge, fn_grants.

DO $selftest$
DECLARE
  v_tables CONSTANT text[] := ARRAY['ttb_shop_prefs','ttb_notices','ttb_credit_reserves'];
  v_funcs  CONSTANT text[] := ARRAY['public.ttb_notice_once(text,text,uuid,date)','public.ttb_reserve_credits(uuid,uuid,uuid,integer)',
                                    'public.ttb_draw_reserve(uuid,integer)','public.ttb_release_reserve(uuid)',
                                    'public.ttb_debit_reply(uuid,integer,text)','public.ttb_refund_reply(uuid,integer,text)'];
  v_t      text;
  v_p      text;
  v_bad    text;
  v_n      int;
  v_ok     boolean;
  v_user   uuid;
  v_acct   uuid;
  v_shop   uuid := gen_random_uuid();
  v_m1     uuid := gen_random_uuid();
  v_m2     uuid := gen_random_uuid();
  v_m3     uuid := gen_random_uuid();
  v_bal    int;
BEGIN
  -- catalog: RLS on, no policies, the new columns exist ----------------------------------------
  FOREACH v_t IN ARRAY v_tables LOOP
    SELECT count(*) INTO v_n FROM pg_class WHERE oid = to_regclass('public.' || v_t) AND relrowsecurity;
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: % missing or RLS is off', v_t; END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL catalog: % has % policies', v_t, v_n; END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND is_nullable = 'YES'
     AND ((table_name = 'ttb_orders' AND column_name = 'shop_id')
       OR (table_name = 'ttb_messages' AND column_name IN ('shop_id', 'credits')));
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL catalog: % of 3 new nullable columns', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.ttb_shop_prefs'::regclass AND contype = 'f' AND confdeltype = 'c' AND confrelid = 'public.ussd_shop_codes'::regclass;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: ttb_shop_prefs has no ON DELETE CASCADE foreign key to ussd_shop_codes'; END IF;

  -- grants: nothing for anon or authenticated; service_role never TRUNCATE or DELETE ------------
  FOREACH v_t IN ARRAY v_tables LOOP
    FOREACH v_p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
      IF has_table_privilege('anon', 'public.' || v_t, v_p) OR has_table_privilege('authenticated', 'public.' || v_t, v_p) THEN
        RAISE EXCEPTION 'FAIL grants: anon or authenticated has % on %', v_p, v_t;
      END IF;
      IF v_p IN ('TRUNCATE', 'DELETE') AND has_table_privilege('service_role', 'public.' || v_t, v_p) THEN
        RAISE EXCEPTION 'FAIL grants: service_role has % on %', v_p, v_t;
      END IF;
    END LOOP;
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

  -- heartbeat: quiet_alert_shop accepted, a typo refused ----------------------------------
  INSERT INTO public.ttb_heartbeat (line, last_seen_at) VALUES ('quiet_alert_shop', now()) ON CONFLICT (line) DO NOTHING;
  v_ok := false;
  <<hb_typo>>
  BEGIN
    INSERT INTO public.ttb_heartbeat (line, last_seen_at) VALUES ('typo', now());
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END hb_typo;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL heartbeat: an unknown line was accepted'; END IF;

  -- notice: true once, then false (a NULL shop is one slot) --------------------------------
  IF NOT public.ttb_notice_once('selftest', '0200000101', NULL, current_date) THEN RAISE EXCEPTION 'FAIL notice: first call was not true'; END IF;
  IF public.ttb_notice_once('selftest', '0200000101', NULL, current_date) THEN RAISE EXCEPTION 'FAIL notice: repeat with NULL shop was true'; END IF;
  IF NOT public.ttb_notice_once('selftest', '0200000101', v_shop, current_date) THEN RAISE EXCEPTION 'FAIL notice: other shop was not true'; END IF;
  IF public.ttb_notice_once('selftest', '0200000101', v_shop, current_date) THEN RAISE EXCEPTION 'FAIL notice: repeat was true'; END IF;

  -- a throwaway SMS account holding 5 credits (rolled back with everything else) -------------
  SELECT u.id INTO v_user FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.sms_accounts a WHERE a.user_id = u.id) LIMIT 1;
  IF v_user IS NULL THEN
    INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id INTO v_user;
  END IF;
  INSERT INTO public.sms_accounts (user_id, owner_type, unit_balance, status) VALUES (v_user, 'shop', 5, 'active') RETURNING id INTO v_acct;

  -- reserve: once debits 3 (reason text_to_buy), a repeat debits nothing -------------------------
  IF NOT public.ttb_reserve_credits(v_acct, v_m1, v_shop, 3) THEN RAISE EXCEPTION 'FAIL reserve: first reserve was not true'; END IF;
  IF public.ttb_reserve_credits(v_acct, v_m1, v_shop, 3) THEN RAISE EXCEPTION 'FAIL reserve: repeat was true'; END IF;
  SELECT unit_balance INTO v_bal FROM public.sms_accounts WHERE id = v_acct;
  IF v_bal <> 2 THEN RAISE EXCEPTION 'FAIL reserve: balance % after reserve and repeat (want 2)', v_bal; END IF;
  SELECT count(*) INTO v_n FROM public.sms_unit_transactions
   WHERE sms_account_id = v_acct AND reason = 'text_to_buy' AND ref = 'ttb:' || v_m1::text AND delta = -3;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL reserve: % ledger rows for the reserve (want 1)', v_n; END IF;

  -- race (sequential here; the real parallel case is the row lock + atomic debit): a second reserve for 2 on 2 left works, a third fails
  IF NOT public.ttb_reserve_credits(v_acct, v_m2, v_shop, 2) THEN RAISE EXCEPTION 'FAIL race: second reserve was not true'; END IF;
  v_ok := false;
  <<third>>
  BEGIN
    PERFORM public.ttb_reserve_credits(v_acct, v_m3, v_shop, 1);
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLERRM = 'INSUFFICIENT_CREDITS';
  END third;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL race: overdraw did not raise INSUFFICIENT_CREDITS'; END IF;
  SELECT count(*) INTO v_n FROM public.ttb_credit_reserves WHERE message_id = v_m3;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL race: a reserve row survived the failed debit'; END IF;
  SELECT unit_balance INTO v_bal FROM public.sms_accounts WHERE id = v_acct;
  IF v_bal <> 0 THEN RAISE EXCEPTION 'FAIL race: balance % (want 0)', v_bal; END IF;

  -- inactive account: raises NOT_ACTIVATED and moves nothing ------------------------------------
  UPDATE public.sms_accounts SET status = 'inactive' WHERE id = v_acct;
  v_ok := false;
  <<inactive>>
  BEGIN
    PERFORM public.ttb_debit_reply(v_acct, 1, 'ttb:selftest:inactive');
  EXCEPTION WHEN OTHERS THEN
    v_ok := SQLERRM = 'NOT_ACTIVATED';
  END inactive;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL reserve: inactive account did not raise NOT_ACTIVATED'; END IF;
  UPDATE public.sms_accounts SET status = 'active' WHERE id = v_acct;

  -- draw: within held works, beyond held is false ------------------------------------------
  IF NOT public.ttb_draw_reserve(v_m1, 2) THEN RAISE EXCEPTION 'FAIL draw: within held was false'; END IF;
  IF public.ttb_draw_reserve(v_m1, 2) THEN RAISE EXCEPTION 'FAIL draw: beyond held was true'; END IF;

  -- release: refunds held-used (3-2 = 1) once; a repeat refunds 0; full use refunds 0 ----------------
  IF public.ttb_release_reserve(v_m1) <> 1 THEN RAISE EXCEPTION 'FAIL release: first release did not refund 1'; END IF;
  IF public.ttb_release_reserve(v_m1) <> 0 THEN RAISE EXCEPTION 'FAIL release: repeat refunded something'; END IF;
  IF NOT public.ttb_draw_reserve(v_m2, 2) THEN RAISE EXCEPTION 'FAIL release: could not use the whole reserve'; END IF;
  IF public.ttb_release_reserve(v_m2) <> 0 THEN RAISE EXCEPTION 'FAIL release: a fully used reserve refunded something'; END IF;
  SELECT unit_balance INTO v_bal FROM public.sms_accounts WHERE id = v_acct;
  IF v_bal <> 1 THEN RAISE EXCEPTION 'FAIL release: balance % (want 1)', v_bal; END IF;
  SELECT count(*) INTO v_n FROM public.sms_unit_transactions
   WHERE sms_account_id = v_acct AND reason = 'text_to_buy_refund' AND ref = 'ttb:' || v_m1::text || ':release' AND delta = 1;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL release: % refund ledger rows (want 1)', v_n; END IF;

  -- reply: one debit per ref, one refund per ref ---------------------------------------------
  IF NOT public.ttb_debit_reply(v_acct, 1, 'ttb:selftest:reply') THEN RAISE EXCEPTION 'FAIL reply: debit was false'; END IF;
  IF public.ttb_debit_reply(v_acct, 1, 'ttb:selftest:reply') THEN RAISE EXCEPTION 'FAIL reply: repeat debit was true'; END IF;
  IF NOT public.ttb_refund_reply(v_acct, 1, 'ttb:selftest:reply') THEN RAISE EXCEPTION 'FAIL reply: refund was false'; END IF;
  IF public.ttb_refund_reply(v_acct, 1, 'ttb:selftest:reply') THEN RAISE EXCEPTION 'FAIL reply: repeat refund was true'; END IF;
  IF public.ttb_refund_reply(v_acct, 1, 'ttb:selftest:never') THEN RAISE EXCEPTION 'FAIL reply: refund without a debit was true'; END IF;
  SELECT unit_balance INTO v_bal FROM public.sms_accounts WHERE id = v_acct;
  IF v_bal <> 1 THEN RAISE EXCEPTION 'FAIL reply: balance % (want 1)', v_bal; END IF;

  -- purge: a released reserve and a notice older than the cut-off go; an unreleased one stays -------
  UPDATE public.ttb_credit_reserves SET created_at = now() - interval '1 year' WHERE message_id IN (v_m1, v_m2);
  INSERT INTO public.ttb_credit_reserves (message_id, account_id, shop_id, held, used) VALUES (gen_random_uuid(), v_acct, v_shop, 1, 0);
  UPDATE public.ttb_credit_reserves SET created_at = now() - interval '1 year' WHERE released_at IS NULL;
  UPDATE public.ttb_notices SET created_at = now() - interval '1 year', day = current_date - 365 WHERE kind = 'selftest';
  PERFORM public.ttb_purge(now() - interval '1 day');
  SELECT count(*) INTO v_n FROM public.ttb_credit_reserves WHERE message_id IN (v_m1, v_m2);
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL purge: % old released reserves survived', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.ttb_credit_reserves WHERE released_at IS NULL AND account_id = v_acct;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL purge: the unreleased reserve was deleted'; END IF;
  SELECT count(*) INTO v_n FROM public.ttb_notices WHERE kind = 'selftest';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL purge: % old notices survived', v_n; END IF;

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

  RAISE EXCEPTION 'SELFTEST_OK 0179 shop line tables, reserve ledger, grants and functions';
END $selftest$;
