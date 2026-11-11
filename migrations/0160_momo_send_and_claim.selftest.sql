-- 0160_momo_send_and_claim.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0160_momo_send_and_claim.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and no bare `END;`
-- statement, and that it ends with this DO block (which always RAISEs). (The 0130 incident lesson.)
-- Build it as lib/momo-claim/migration.test.ts does:
--   1. 0160_momo_send_and_claim.sql with BEGIN kept (and both SET LOCALs) and ONLY its final
--      transaction-ending line removed; the trailing "Verify after apply" comment lines may stay;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: every sub-block is labelled and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the tables, the settings rows
-- and every test row are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error
-- means it failed. If the client keeps the session open, send `ROLLBACK;`.
--
-- Scenarios (labels): catalog, grants, deny_anon / deny_authenticated (a real table read under SET LOCAL ROLE),
-- settings_defaults, txid_check, code_check. Needs no user and no wallet: the code check fires before the foreign key.
-- The functions added by the next task get their own scenarios here.

DO $selftest$
DECLARE
  v_tables  CONSTANT text[] := ARRAY['momo_transactions','wallet_topup_sessions','momo_claim_attempts','momo_reconciliation_runs'];
  v_t       text;
  v_p       text;
  v_n       int;
  v_ok      boolean;
  v_val     jsonb;
  v_bad     text;
  v_want    boolean;
BEGIN
  -- catalog: RLS on, no policies, the keys and indexes --------------------------
  FOREACH v_t IN ARRAY v_tables LOOP
    SELECT count(*) INTO v_n FROM pg_class WHERE oid = to_regclass('public.' || v_t) AND relrowsecurity;
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: % missing or RLS is off', v_t; END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL catalog: % has % policies', v_t, v_n; END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'momo_transactions' AND indexdef LIKE 'CREATE UNIQUE INDEX%(transaction_id)%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: momo_transactions.transaction_id unique index found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'wallet_topup_sessions' AND indexdef LIKE 'CREATE UNIQUE INDEX%(code)%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: wallet_topup_sessions.code unique index found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'wallet_topup_sessions' AND indexdef LIKE '%(user_id, status, expires_at)%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: sessions index found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'momo_claim_attempts'
     AND (indexdef LIKE '%(user_id, created_at)%' OR indexdef LIKE '%(transaction_id, created_at)%');
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL catalog: attempts indexes found %', v_n; END IF;

  -- grants: nothing for anon or authenticated, exactly the agreed set for service_role, never DELETE ----
  FOREACH v_t IN ARRAY v_tables LOOP
    FOREACH v_p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
      IF has_table_privilege('anon', 'public.' || v_t, v_p) OR has_table_privilege('authenticated', 'public.' || v_t, v_p) THEN
        RAISE EXCEPTION 'FAIL grants: anon or authenticated has % on %', v_p, v_t;
      END IF;
      v_want := CASE v_t
        WHEN 'momo_transactions'         THEN v_p IN ('SELECT','INSERT','UPDATE')
        WHEN 'wallet_topup_sessions'     THEN v_p IN ('SELECT','INSERT','UPDATE')
        WHEN 'momo_claim_attempts'       THEN v_p IN ('SELECT')
        ELSE                                  v_p IN ('SELECT','INSERT') END;
      IF has_table_privilege('service_role', 'public.' || v_t, v_p) IS DISTINCT FROM v_want THEN
        RAISE EXCEPTION 'FAIL grants: service_role % on % should be %', v_p, v_t, v_want;
      END IF;
    END LOOP;
  END LOOP;

  -- deny_anon / deny_authenticated: a real read under each role is refused ----------
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

  -- settings_defaults ------------------------------------------------------------
  SELECT value INTO v_val FROM public.admin_settings WHERE key = 'momo_claim_enabled';
  IF v_val IS DISTINCT FROM '{"value": false}'::jsonb THEN RAISE EXCEPTION 'FAIL settings_defaults: momo_claim_enabled is %', v_val; END IF;
  SELECT count(*) INTO v_n FROM public.admin_settings WHERE key IN
    ('momo_claim_enabled','momo_payment_accounts','momo_account_name','momo_claim_fee_customer','momo_claim_fee_dealer',
     'momo_min_claimable','momo_max_claimable','momo_sms_sender_allowlist','momo_txid_regression_threshold',
     'momo_auto_claim_review_threshold','momo_auto_claim_daily_cap');
  IF v_n <> 11 THEN RAISE EXCEPTION 'FAIL settings_defaults: % of 11 keys', v_n; END IF;

  -- txid_check: 8-15 digits or X + uuid; anything else is refused ----------------------
  FOREACH v_bad IN ARRAY ARRAY['1234567','1234567890123456','12345678a','','x00000000-0000-0000-0000-000000000000'] LOOP
    v_ok := false;
    <<bad_txid>>
    BEGIN
      INSERT INTO public.momo_transactions (transaction_id, raw_sms, status) VALUES (v_bad, 'selftest', 'pending');
    EXCEPTION WHEN check_violation THEN
      v_ok := true;
    END bad_txid;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL txid_check: accepted [%]', v_bad; END IF;
  END LOOP;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status) VALUES ('900000000001', 'selftest', 'pending');
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status) VALUES ('X' || gen_random_uuid()::text, 'selftest', 'unparsed');
  v_ok := false;
  <<dup_txid>>
  BEGIN
    INSERT INTO public.momo_transactions (transaction_id, raw_sms, status) VALUES ('900000000001', 'selftest', 'pending');
  EXCEPTION WHEN unique_violation THEN
    v_ok := true;
  END dup_txid;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL txid_check: a duplicate transaction_id was accepted'; END IF;

  -- code_check: the alphabet has no I, L or O and no digit below 2 ------------------------
  FOREACH v_bad IN ARRAY ARRAY['KXO4821','KXI4821','KXL4821','KXM1821','KXM0821','KX4821','KXM48210','kxm4821'] LOOP
    v_ok := false;
    <<bad_code>>
    BEGIN
      INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
      VALUES (gen_random_uuid(), v_bad, 10, 0, 10, now());
    EXCEPTION WHEN check_violation THEN
      v_ok := true;
    END bad_code;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL code_check: accepted [%]', v_bad; END IF;
  END LOOP;

  RAISE EXCEPTION 'SELFTEST_OK 0160 tables, grants, settings and checks';
END $selftest$;
