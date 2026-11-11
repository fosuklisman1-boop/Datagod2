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
-- settings_defaults, txid_check, code_check. The code check needs no user: it fires before the foreign key.
--
-- Money functions (labels): setup_money, fn_catalog, fn_grants, fn_deny, first_claim, admin_credit_flagged,
-- admin_reason_required, credited, already_credited, webhook_then_manual, payment_before_session, manual_amount_mismatch,
-- webhook_amount_mismatch, flagged_not_claimable, no_session, webhook_no_session, above_review_threshold, daily_cap,
-- rate_limited, daily_limit, too_many_attempts, admin_unflag, admin_credit_unparsed, dealer_fee, final_balance.
-- Picks the admin (public.users.role = 'admin', joined to auth.users and public.wallets) with the largest wallet and holds
-- that wallet's row lock from the start; reads one dealer (role 'dealer') for the fee only. Credits a few pesewas to the
-- admin, all rolled back. now() is fixed inside one transaction, so the scenarios clear the admin's attempt rows between
-- claim-box calls (the 30-second limit would otherwise trip) and back-date rows where a time window is tested.
-- Settings are pinned to the defaults first. Fails if any MOMO- ledger row already exists. What it cannot cover: two
-- sessions at once (the session, row and wallet locks and the per-user advisory lock).

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
  -- Money functions (Task 5)
  v_entry    CONSTANT text[] := ARRAY['public.claim_via_wallet_topup_session(text,text)', 'public.claim_momo_via_session(uuid,text,uuid)',
                                      'public.admin_credit_momo_transaction(text,uuid,uuid,text,numeric)', 'public.admin_unflag_momo_transaction(text,uuid,text)'];
  v_internal CONSTANT text[] := ARRAY['public.claim_momo_transaction(text,uuid,uuid,boolean,text)', 'public.momo_credit_wallet(text,uuid,numeric)',
                                      'public.momo_claim_fee(uuid,numeric)', 'public.momo_setting_numeric(text,numeric)'];
  v_user    uuid;
  v_dealer  uuid;
  v_bal0    numeric;
  v_cred0   numeric;
  v_bal     numeric;
  v_cred    numeric;
  v_paid    numeric := 0;
  v_credits int := 0;
  v_today   numeric;
  v_fee     numeric;
  v_res     text;
  v_got     text;
  v_seen    text;
  v_called  boolean;
  v_s       uuid;
  v_s2      uuid;
  v_code    text;
  v_tx      text;
  v_row     public.momo_transactions%ROWTYPE;
  v_sess    public.wallet_topup_sessions%ROWTYPE;
  v_i       int;
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

  -- ======================= Money functions =======================
  -- setup_money: the admin with the largest wallet (its row lock held to the end) and any dealer. Settings pinned to the
  -- defaults so the scenarios do not depend on what an admin has set.
  SELECT u.id, w.balance, COALESCE(w.total_credited, 0) INTO v_user, v_bal0, v_cred0
    FROM public.users u
    JOIN auth.users au ON au.id = u.id
    JOIN public.wallets w ON w.user_id = u.id
   WHERE u.role = 'admin'
   ORDER BY w.balance DESC, u.id
   LIMIT 1
   FOR UPDATE OF w;
  IF v_user IS NULL THEN RAISE EXCEPTION 'FAIL setup_money: no admin with a wallet'; END IF;
  SELECT u.id INTO v_dealer FROM public.users u WHERE u.role = 'dealer' ORDER BY u.id LIMIT 1;
  IF v_dealer IS NULL THEN RAISE EXCEPTION 'FAIL setup_money: no dealer'; END IF;
  SELECT count(*) INTO v_n FROM public.transactions t WHERE t.reference_id LIKE 'MOMO-%';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL setup_money: % MOMO- ledger rows already exist', v_n; END IF;
  UPDATE public.admin_settings SET value = '{"value": 0}'::jsonb WHERE key IN ('momo_claim_fee_customer', 'momo_claim_fee_dealer');
  UPDATE public.admin_settings SET value = '{"value": 500}'::jsonb WHERE key = 'momo_auto_claim_review_threshold';
  UPDATE public.admin_settings SET value = '{"value": 3000}'::jsonb WHERE key = 'momo_auto_claim_daily_cap';

  -- fn_catalog: every function SECURITY DEFINER with search_path '' and one overload ------------------
  FOREACH v_t IN ARRAY v_entry || v_internal LOOP
    SELECT count(*) INTO v_n FROM pg_proc p WHERE p.oid = v_t::regprocedure AND p.prosecdef AND p.proconfig = ARRAY['search_path=""'];
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL fn_catalog: % is not SECURITY DEFINER with an empty search_path', v_t; END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('claim_via_wallet_topup_session','claim_momo_via_session','admin_credit_momo_transaction','admin_unflag_momo_transaction',
                       'claim_momo_transaction','momo_credit_wallet','momo_claim_fee','momo_setting_numeric');
  IF v_n <> 8 THEN RAISE EXCEPTION 'FAIL fn_catalog: % functions (overloads?)', v_n; END IF;

  -- fn_grants: entry points service_role only; internal functions nobody --------------------------------
  FOREACH v_t IN ARRAY v_entry || v_internal LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') OR has_function_privilege('authenticated', v_t, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL fn_grants: anon or authenticated can execute %', v_t;
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.oid = v_t::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE';
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL fn_grants: PUBLIC can execute %', v_t; END IF;
    IF has_function_privilege('service_role', v_t, 'EXECUTE') IS DISTINCT FROM (v_t = ANY (v_entry)) THEN
      RAISE EXCEPTION 'FAIL fn_grants: service_role EXECUTE on % should be %', v_t, (v_t = ANY (v_entry));
    END IF;
  END LOOP;

  -- fn_deny: a real call is refused for authenticated (entry point) and service_role (internal) ---------------
  FOREACH v_bad IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    v_called := false; v_got := NULL; v_seen := NULL;
    <<fn_deny>>
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', v_bad);
      v_seen := current_user;
      IF v_bad = 'authenticated' THEN
        PERFORM public.claim_momo_via_session(v_user, '910000009999', NULL);
      ELSE
        PERFORM public.claim_momo_transaction('910000009999', v_user, gen_random_uuid(), true, 'manual');
      END IF;
      v_called := true;
    EXCEPTION WHEN insufficient_privilege THEN
      v_got := SQLERRM;
    END fn_deny;
    RESET ROLE;
    IF v_seen IS DISTINCT FROM v_bad THEN RAISE EXCEPTION 'FAIL fn_deny: could not switch to % (err %)', v_bad, v_got; END IF;
    IF v_called OR v_got IS NULL OR v_got NOT LIKE 'permission denied for function%' THEN RAISE EXCEPTION 'FAIL fn_deny: % called=% err=%', v_bad, v_called, v_got; END IF;
  END LOOP;

  -- first_claim: the admin has never claimed, so the claim box sends it to review -------------------
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2222', 0.50, 0, 0.50, now() + interval '1 hour') RETURNING id INTO v_s;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('910000000001', 'selftest', 'pending', 0.50);
  v_res := public.claim_momo_via_session(v_user, '910000000001', v_s);
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '910000000001';
  IF v_res <> 'under_review' OR v_row.status <> 'flagged' OR v_row.flag_reasons <> ARRAY['first_claim'] OR v_row.session_id IS DISTINCT FROM v_s
     OR v_row.claimed_by IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL first_claim: % / % / %', v_res, v_row.status, v_row.flag_reasons;
  END IF;
  IF (SELECT s.status FROM public.wallet_topup_sessions s WHERE s.id = v_s) <> 'pending' THEN RAISE EXCEPTION 'FAIL first_claim: session moved'; END IF;
  SELECT w.balance INTO v_bal FROM public.wallets w WHERE w.user_id = v_user;
  IF v_bal <> v_bal0 THEN RAISE EXCEPTION 'FAIL first_claim: wallet moved'; END IF;

  -- admin_credit_flagged: approve credits once; the second call is already_credited; the session closes --------------
  v_res := public.admin_credit_momo_transaction('910000000001', v_user, v_user, 'selftest approve');
  IF v_res <> 'credited' THEN RAISE EXCEPTION 'FAIL admin_credit_flagged: %', v_res; END IF;
  v_paid := v_paid + 0.50; v_credits := v_credits + 1;
  v_res := public.admin_credit_momo_transaction('910000000001', v_user, v_user, 'selftest approve');
  IF v_res <> 'already_credited' THEN RAISE EXCEPTION 'FAIL admin_credit_flagged: second call %', v_res; END IF;
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '910000000001';
  IF v_row.status <> 'claimed' OR v_row.claimed_by IS DISTINCT FROM v_user OR v_row.credited_by_admin IS DISTINCT FROM v_user
     OR v_row.admin_reason IS DISTINCT FROM 'selftest approve' OR v_row.net_amount <> 0.50 THEN
    RAISE EXCEPTION 'FAIL admin_credit_flagged: row %', v_row.status;
  END IF;
  SELECT * INTO v_sess FROM public.wallet_topup_sessions s WHERE s.id = v_s;
  IF v_sess.status <> 'claimed' OR v_sess.claimed_transaction_id IS DISTINCT FROM '910000000001' THEN RAISE EXCEPTION 'FAIL admin_credit_flagged: session %', v_sess.status; END IF;
  SELECT count(*) INTO v_n FROM public.transactions t
   WHERE t.reference_id = 'MOMO-910000000001' AND t.user_id = v_user AND t.type = 'credit' AND t.source = 'momo_claim' AND t.amount = 0.50
     AND t.balance_before = v_bal0 AND t.balance_after = v_bal0 + 0.50 AND t.status = 'completed';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL admin_credit_flagged: % ledger rows', v_n; END IF;

  -- admin_reason_required: empty, blank, 201 chars, NULL -> BAD_INPUT, nothing written --------------------------
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('910000000002', 'selftest', 'flagged', 0.10);
  FOREACH v_bad IN ARRAY ARRAY['', '   ', repeat('x', 201), NULL] LOOP
    v_got := NULL;
    <<admin_reason_required>>
    BEGIN
      PERFORM public.admin_credit_momo_transaction('910000000002', v_user, v_user, v_bad);
      v_got := 'NO_ERROR';
    EXCEPTION WHEN OTHERS THEN
      v_got := SQLERRM;
    END admin_reason_required;
    IF v_got IS DISTINCT FROM 'BAD_INPUT' THEN RAISE EXCEPTION 'FAIL admin_reason_required: got %', v_got; END IF;
  END LOOP;
  IF (SELECT m.status FROM public.momo_transactions m WHERE m.transaction_id = '910000000002') <> 'flagged' THEN
    RAISE EXCEPTION 'FAIL admin_reason_required: row moved';
  END IF;

  -- credited: own session, matching amount, not a first claim -> wallet + net, ledger MOMO-<txid>, row and session claimed ----
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2223', 0.40, 0, 0.40, now() + interval '1 hour') RETURNING id INTO v_s;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('910000000003', 'selftest', 'pending', 0.40);
  v_res := public.claim_momo_via_session(v_user, '910000000003', v_s);
  IF v_res <> 'credited' THEN RAISE EXCEPTION 'FAIL credited: %', v_res; END IF;
  v_paid := v_paid + 0.40; v_credits := v_credits + 1;
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '910000000003';
  IF v_row.status <> 'claimed' OR v_row.claimed_by IS DISTINCT FROM v_user OR v_row.fee <> 0 OR v_row.net_amount <> 0.40 OR v_row.session_id IS DISTINCT FROM v_s THEN
    RAISE EXCEPTION 'FAIL credited: row %', v_row.status;
  END IF;
  SELECT * INTO v_sess FROM public.wallet_topup_sessions s WHERE s.id = v_s;
  IF v_sess.status <> 'claimed' OR v_sess.claimed_transaction_id IS DISTINCT FROM '910000000003' THEN RAISE EXCEPTION 'FAIL credited: session %', v_sess.status; END IF;
  SELECT w.balance INTO v_bal FROM public.wallets w WHERE w.user_id = v_user;
  IF v_bal <> v_bal0 + v_paid THEN RAISE EXCEPTION 'FAIL credited: balance %', v_bal; END IF;
  SELECT count(*) INTO v_n FROM public.momo_claim_attempts a WHERE a.user_id = v_user AND a.transaction_id = '910000000003' AND a.result = 'credited';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL credited: % attempt rows', v_n; END IF;

  -- already_credited: the same txid again (another open session exists) -> already_credited, nothing moves -----------
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2224', 0.40, 0, 0.40, now() + interval '1 hour') RETURNING id INTO v_s2;
  v_res := public.claim_momo_via_session(v_user, '910000000003', NULL);
  IF v_res <> 'already_credited' THEN RAISE EXCEPTION 'FAIL already_credited: %', v_res; END IF;
  SELECT count(*) INTO v_n FROM public.transactions t WHERE t.reference_id = 'MOMO-910000000003';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL already_credited: % ledger rows', v_n; END IF;
  IF (SELECT s.status FROM public.wallet_topup_sessions s WHERE s.id = v_s2) <> 'pending' THEN RAISE EXCEPTION 'FAIL already_credited: session moved'; END IF;

  -- webhook_then_manual: the webhook credits; the claim box and a second webhook (another open session) then answer
  -- already_credited; exactly one ledger row -----------------------------------------------------------------
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2225', 0.30, 0, 0.30, now() + interval '1 hour') RETURNING id INTO v_s;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('910000000004', 'selftest', 'pending', 0.30);
  v_res := public.claim_via_wallet_topup_session('SAA2225', '910000000004');
  IF v_res <> 'credited' THEN RAISE EXCEPTION 'FAIL webhook_then_manual: webhook %', v_res; END IF;
  v_paid := v_paid + 0.30; v_credits := v_credits + 1;
  v_res := public.claim_momo_via_session(v_user, '910000000004', NULL);
  IF v_res <> 'already_credited' THEN RAISE EXCEPTION 'FAIL webhook_then_manual: manual %', v_res; END IF;
  v_res := public.claim_via_wallet_topup_session('SAA2224', '910000000004');
  IF v_res <> 'already_credited' THEN RAISE EXCEPTION 'FAIL webhook_then_manual: second webhook %', v_res; END IF;
  IF (SELECT s.status FROM public.wallet_topup_sessions s WHERE s.id = v_s2) <> 'pending' THEN RAISE EXCEPTION 'FAIL webhook_then_manual: session moved'; END IF;
  SELECT count(*) INTO v_n FROM public.transactions t WHERE t.reference_id = 'MOMO-910000000004';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL webhook_then_manual: % ledger rows', v_n; END IF;

  -- payment_before_session: received a minute before the session was created -> not_matched, row pending ----------
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2226', 0.20, 0, 0.20, now() + interval '1 hour') RETURNING id INTO v_s;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount, received_at)
  VALUES ('910000000005', 'selftest', 'pending', 0.20, now() - interval '1 minute');
  v_res := public.claim_momo_via_session(v_user, '910000000005', v_s);
  IF v_res <> 'not_matched' THEN RAISE EXCEPTION 'FAIL payment_before_session: %', v_res; END IF;
  IF (SELECT m.status FROM public.momo_transactions m WHERE m.transaction_id = '910000000005') <> 'pending' THEN
    RAISE EXCEPTION 'FAIL payment_before_session: row moved';
  END IF;

  -- manual_amount_mismatch: 0.21 against a 0.20 session -> not_matched, row unchanged ----------------------------
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('910000000006', 'selftest', 'pending', 0.21);
  v_res := public.claim_momo_via_session(v_user, '910000000006', v_s);
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '910000000006';
  IF v_res <> 'not_matched' OR v_row.status <> 'pending' OR v_row.session_id IS NOT NULL OR cardinality(v_row.flag_reasons) <> 0 THEN
    RAISE EXCEPTION 'FAIL manual_amount_mismatch: % / %', v_res, v_row.status;
  END IF;

  -- webhook_amount_mismatch: 0.21 against the 0.20 session by code -> flagged amount_mismatch, session linked ------
  v_res := public.claim_via_wallet_topup_session('SAA2226', '910000000006');
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '910000000006';
  IF v_res <> 'under_review' OR v_row.status <> 'flagged' OR v_row.flag_reasons <> ARRAY['amount_mismatch'] OR v_row.session_id IS DISTINCT FROM v_s
     OR v_row.claimed_by IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL webhook_amount_mismatch: % / % / %', v_res, v_row.status, v_row.flag_reasons;
  END IF;
  IF (SELECT s.status FROM public.wallet_topup_sessions s WHERE s.id = v_s) <> 'pending' THEN RAISE EXCEPTION 'FAIL webhook_amount_mismatch: session moved'; END IF;

  -- flagged_not_claimable: that flagged row, and voided / unparsed / rejected_sender rows, never credit ---------------
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  v_res := public.claim_via_wallet_topup_session('SAA2226', '910000000006');
  IF v_res <> 'not_matched' THEN RAISE EXCEPTION 'FAIL flagged_not_claimable: webhook %', v_res; END IF;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES
    ('910000000007', 'selftest', 'flagged', 0.20), ('910000000008', 'selftest', 'voided', 0.20), ('910000000009', 'selftest', 'unparsed', 0.20);
  FOREACH v_tx IN ARRAY ARRAY['910000000007', '910000000008', '910000000009'] LOOP
    v_res := public.claim_momo_via_session(v_user, v_tx, v_s);
    IF v_res <> 'not_matched' THEN RAISE EXCEPTION 'FAIL flagged_not_claimable: % gave %', v_tx, v_res; END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM public.transactions t WHERE t.reference_id IN ('MOMO-910000000006', 'MOMO-910000000007', 'MOMO-910000000008', 'MOMO-910000000009');
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL flagged_not_claimable: % ledger rows', v_n; END IF;

  -- no_session: someone else's / unknown session id -> no_session, logged as NOSESSION -----------------------
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('910000000010', 'selftest', 'pending', 0.20);
  v_res := public.claim_momo_via_session(v_user, '910000000010', gen_random_uuid());
  IF v_res <> 'no_session' THEN RAISE EXCEPTION 'FAIL no_session: %', v_res; END IF;
  SELECT count(*) INTO v_n FROM public.momo_claim_attempts a WHERE a.user_id = v_user AND a.transaction_id = 'NOSESSION' AND a.result = 'no_session';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL no_session: % attempt rows', v_n; END IF;

  -- webhook_no_session: unknown code, expired session, session created after the payment -> no_session, row pending ----
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2227', 0.20, 0, 0.20, now() - interval '1 second');
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount, received_at)
  VALUES ('910000000011', 'selftest', 'pending', 0.20, now() - interval '1 minute');
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2228', 0.20, 0, 0.20, now() + interval '1 hour');
  FOR v_code, v_tx IN SELECT * FROM (VALUES ('ZZZ9999', '910000000010'), ('SAA2227', '910000000010'), ('SAA2228', '910000000011')) AS t(c, x) LOOP
    v_res := public.claim_via_wallet_topup_session(v_code, v_tx);
    IF v_res <> 'no_session' THEN RAISE EXCEPTION 'FAIL webhook_no_session: % gave %', v_code, v_res; END IF;
    SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = v_tx;
    IF v_row.status <> 'pending' OR v_row.session_id IS NOT NULL THEN RAISE EXCEPTION 'FAIL webhook_no_session: % moved the row', v_code; END IF;
  END LOOP;

  -- above_review_threshold: net 500.01 > 500 -> under_review ------------------------------------------
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2229', 500.01, 0, 500.01, now() + interval '1 hour') RETURNING id INTO v_s;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('910000000012', 'selftest', 'pending', 500.01);
  v_res := public.claim_momo_via_session(v_user, '910000000012', v_s);
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '910000000012';
  IF v_res <> 'under_review' OR v_row.flag_reasons <> ARRAY['above_review_threshold'] THEN
    RAISE EXCEPTION 'FAIL above_review_threshold: % / %', v_res, v_row.flag_reasons;
  END IF;

  -- daily_cap: today's claimed net + this one > 3000 -> under_review; the helper row is then voided ---------------
  SELECT COALESCE(sum(m.net_amount), 0) INTO v_today FROM public.momo_transactions m WHERE m.claimed_by = v_user AND m.status = 'claimed';
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount, fee, net_amount, claimed_by, claimed_at)
  VALUES ('910000000013', 'selftest', 'claimed', 3000 - v_today - 0.05, 0, 3000 - v_today - 0.05, v_user, now());
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2232', 0.10, 0, 0.10, now() + interval '1 hour') RETURNING id INTO v_s;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('910000000014', 'selftest', 'pending', 0.10);
  v_res := public.claim_momo_via_session(v_user, '910000000014', v_s);
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '910000000014';
  IF v_res <> 'under_review' OR v_row.flag_reasons <> ARRAY['daily_cap'] THEN RAISE EXCEPTION 'FAIL daily_cap: % / %', v_res, v_row.flag_reasons; END IF;
  UPDATE public.momo_transactions m SET status = 'voided' WHERE m.transaction_id = '910000000013';

  -- rate_limited: a 4th call inside 30 seconds -> rate_limited, logged as NOSESSION ------------------------
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  FOR v_i IN 1..3 LOOP
    v_res := public.claim_momo_via_session(v_user, '910000000010', gen_random_uuid());
    IF v_res <> 'no_session' THEN RAISE EXCEPTION 'FAIL rate_limited: call % gave %', v_i, v_res; END IF;
  END LOOP;
  v_res := public.claim_momo_via_session(v_user, '910000000010', gen_random_uuid());
  IF v_res <> 'rate_limited' THEN RAISE EXCEPTION 'FAIL rate_limited: 4th call gave %', v_res; END IF;
  SELECT count(*) INTO v_n FROM public.momo_claim_attempts a WHERE a.user_id = v_user AND a.transaction_id = 'NOSESSION' AND a.result = 'rate_limited';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL rate_limited: % attempt rows', v_n; END IF;

  -- daily_limit: 20 failed attempts in the last 24 h -> daily_limit -------------------------------------
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result, created_at)
  SELECT v_user, 'NOSESSION', 'not_matched', now() - interval '1 hour' FROM generate_series(1, 20);
  v_res := public.claim_momo_via_session(v_user, '910000000010', NULL);
  IF v_res <> 'daily_limit' THEN RAISE EXCEPTION 'FAIL daily_limit: %', v_res; END IF;

  -- too_many_attempts: 4 failed attempts by others + 1 by the admin on one txid -> flagged too_many_attempts ---------
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('910000000015', 'selftest', 'pending', 0.20);
  INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result)
  SELECT gen_random_uuid(), '910000000015', 'not_matched' FROM generate_series(1, 4);
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2233', 0.21, 0, 0.21, now() + interval '1 hour') RETURNING id INTO v_s;
  v_res := public.claim_momo_via_session(v_user, '910000000015', v_s);
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '910000000015';
  IF v_res <> 'not_matched' OR v_row.status <> 'flagged' OR v_row.flag_reasons <> ARRAY['too_many_attempts'] THEN
    RAISE EXCEPTION 'FAIL too_many_attempts: % / % / %', v_res, v_row.status, v_row.flag_reasons;
  END IF;

  -- admin_unflag: flagged -> pending, who/why recorded, counter restarted (older attempts no longer count) ---------
  UPDATE public.momo_claim_attempts a SET created_at = a.created_at - interval '1 minute' WHERE a.transaction_id = '910000000015';
  v_res := public.admin_unflag_momo_transaction('910000000015', v_user, 'selftest unflag');
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '910000000015';
  IF v_res <> 'unflagged' OR v_row.status <> 'pending' OR v_row.unflagged_by IS DISTINCT FROM v_user OR v_row.unflag_reason IS DISTINCT FROM 'selftest unflag'
     OR v_row.unflagged_at IS NULL OR v_row.attempts_reset_at <> now() THEN
    RAISE EXCEPTION 'FAIL admin_unflag: % / %', v_res, v_row.status;
  END IF;
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  v_res := public.claim_momo_via_session(v_user, '910000000015', v_s);
  IF v_res <> 'not_matched' OR (SELECT m.status FROM public.momo_transactions m WHERE m.transaction_id = '910000000015') <> 'pending' THEN
    RAISE EXCEPTION 'FAIL admin_unflag: after reset %', v_res;
  END IF;
  v_got := NULL;
  <<admin_unflag_again>>
  BEGIN
    PERFORM public.admin_unflag_momo_transaction('910000000015', v_user, 'again');
    v_got := 'NO_ERROR';
  EXCEPTION WHEN OTHERS THEN
    v_got := SQLERRM;
  END admin_unflag_again;
  IF v_got IS DISTINCT FROM 'BAD_STATE' THEN RAISE EXCEPTION 'FAIL admin_unflag: unflag of a pending row gave %', v_got; END IF;

  -- admin_credit_unparsed: no amount on the row -> p_amount required, then stored -----------------------------
  v_tx := 'X' || gen_random_uuid()::text;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status) VALUES (v_tx, 'selftest', 'unparsed');
  v_got := NULL;
  <<admin_credit_unparsed>>
  BEGIN
    PERFORM public.admin_credit_momo_transaction(v_tx, v_user, v_user, 'selftest unparsed');
    v_got := 'NO_ERROR';
  EXCEPTION WHEN OTHERS THEN
    v_got := SQLERRM;
  END admin_credit_unparsed;
  IF v_got IS DISTINCT FROM 'BAD_INPUT' THEN RAISE EXCEPTION 'FAIL admin_credit_unparsed: no amount gave %', v_got; END IF;
  v_res := public.admin_credit_momo_transaction(v_tx, v_user, v_user, 'selftest unparsed', 0.15);
  IF v_res <> 'credited' THEN RAISE EXCEPTION 'FAIL admin_credit_unparsed: %', v_res; END IF;
  v_paid := v_paid + 0.15; v_credits := v_credits + 1;
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = v_tx;
  IF v_row.status <> 'claimed' OR v_row.amount <> 0.15 OR v_row.net_amount <> 0.15 THEN RAISE EXCEPTION 'FAIL admin_credit_unparsed: row %', v_row.status; END IF;

  -- dealer_fee: dealer 1.5 %, customer 1 %, rounded up to the pesewa; a claim then credits the net --------------------
  UPDATE public.admin_settings SET value = '{"value": 1}'::jsonb WHERE key = 'momo_claim_fee_customer';
  UPDATE public.admin_settings SET value = '{"value": 1.5}'::jsonb WHERE key = 'momo_claim_fee_dealer';
  SELECT f.fee INTO v_fee FROM public.momo_claim_fee(v_dealer, 10.01) f;
  IF v_fee <> 0.16 THEN RAISE EXCEPTION 'FAIL dealer_fee: dealer fee %', v_fee; END IF;
  SELECT f.fee INTO v_fee FROM public.momo_claim_fee(v_user, 10.01) f;
  IF v_fee <> 0.11 THEN RAISE EXCEPTION 'FAIL dealer_fee: customer fee %', v_fee; END IF;
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'SAA2234', 1.00, 0.01, 0.99, now() + interval '1 hour') RETURNING id INTO v_s;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('910000000016', 'selftest', 'pending', 1.00);
  v_res := public.claim_momo_via_session(v_user, '910000000016', v_s);
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '910000000016';
  IF v_res <> 'credited' OR v_row.fee <> 0.01 OR v_row.net_amount <> 0.99 THEN RAISE EXCEPTION 'FAIL dealer_fee: % fee %', v_res, v_row.fee; END IF;
  v_paid := v_paid + 0.99; v_credits := v_credits + 1;
  UPDATE public.admin_settings SET value = '{"value": 0}'::jsonb WHERE key IN ('momo_claim_fee_customer', 'momo_claim_fee_dealer');

  -- final_balance: the wallet and total_credited moved by exactly the credits; one ledger row per credit -------------
  SELECT w.balance, COALESCE(w.total_credited, 0) INTO v_bal, v_cred FROM public.wallets w WHERE w.user_id = v_user;
  IF v_bal <> v_bal0 + v_paid OR v_cred <> v_cred0 + v_paid THEN
    RAISE EXCEPTION 'FAIL final_balance: % / % after crediting %', v_bal, v_cred, v_paid;
  END IF;
  SELECT count(*), COALESCE(sum(t.amount), 0) INTO v_n, v_fee FROM public.transactions t WHERE t.reference_id LIKE 'MOMO-%';
  IF v_n <> v_credits OR v_fee <> v_paid THEN RAISE EXCEPTION 'FAIL final_balance: % ledger rows totalling %', v_n, v_fee; END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0160 tables, grants, settings, checks and money functions';
END $selftest$;
