-- 0161_momo_first_claim_review_toggle.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0161_momo_first_claim_review_toggle.sql (on a database where 0160 is
-- applied).
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must ASSERT before
-- anything is sent to production that the run string contains no COMMIT and no bare `END;` statement, and that it ends
-- with this DO block (which always RAISEs). (The 0130 incident lesson.) Build it as lib/momo-claim/migration-0161.test.ts
-- does:
--   1. 0161_momo_first_claim_review_toggle.sql with BEGIN kept (and both SET LOCALs) and ONLY its final
--      transaction-ending line removed; the trailing "Verify after apply" comment lines may stay;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward.
--   The DO body has no bare `END;`: the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new function body, the
-- setting row and every test row are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or
-- other error means it failed. If the client keeps the session open, send `ROLLBACK;`.
--
-- Scenarios (labels): setup, setting_default, fn_catalog, fn_grants, wallet_lock_first, review_on_flags_first_claim,
-- malformed_keeps_review, off_above_threshold_still_flagged, off_first_claim_credited.
-- Picks a user with a wallet and NO claimed momo row (an admin first, largest wallet) and holds that wallet's row lock from
-- the start. Credits 0.40 to them, rolled back. Settings are pinned to 0160's defaults first. Uses txids 91610000xxxx and
-- session codes QQQ62x2 / QQR222x, and fails if any of them already exist.

DO $selftest$
DECLARE
  v_fn      CONSTANT text := 'public.claim_momo_transaction(text,uuid,uuid,boolean,text)';
  v_user    uuid;
  v_bal0    numeric;
  v_bal     numeric;
  v_n       int;
  v_res     text;
  v_src     text;
  v_s       uuid;
  v_code    text;
  v_tx      text;
  v_i       int;
  v_vals    CONSTANT text[] := ARRAY['{"value": "false"}', '{"value": 0}', '{"value": null}', '{"value": "off"}', '{}', 'false', '[false]', 'MISSING'];
  v_row     public.momo_transactions%ROWTYPE;
  v_sess    public.wallet_topup_sessions%ROWTYPE;
BEGIN
  -- setup: a user with a wallet and no claimed momo row (its wallet lock held to the end); fixed ids unused ------------
  SELECT u.id, w.balance INTO v_user, v_bal0
    FROM public.users u
    JOIN auth.users au ON au.id = u.id
    JOIN public.wallets w ON w.user_id = u.id
   WHERE NOT EXISTS (SELECT 1 FROM public.momo_transactions m WHERE m.claimed_by = u.id AND m.status = 'claimed')
   ORDER BY (u.role = 'admin') DESC, w.balance DESC, u.id
   LIMIT 1
   FOR UPDATE OF w;
  IF v_user IS NULL THEN RAISE EXCEPTION 'FAIL setup: no user with a wallet and no claimed momo row'; END IF;
  SELECT count(*) INTO v_n FROM public.momo_transactions m WHERE m.transaction_id LIKE '91610000%';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL setup: % momo rows already use the test txids', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.transactions t WHERE t.reference_id LIKE 'MOMO-91610000%';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL setup: % ledger rows already use the test txids', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.wallet_topup_sessions s WHERE s.code LIKE 'QQQ62%' OR s.code LIKE 'QQR222%';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL setup: % sessions already use the test codes', v_n; END IF;
  UPDATE public.admin_settings SET value = '{"value": 0}'::jsonb WHERE key IN ('momo_claim_fee_customer', 'momo_claim_fee_dealer');
  UPDATE public.admin_settings SET value = '{"value": 500}'::jsonb WHERE key = 'momo_auto_claim_review_threshold';
  UPDATE public.admin_settings SET value = '{"value": 3000}'::jsonb WHERE key = 'momo_auto_claim_daily_cap';

  -- setting_default: seeded ON, with a description ---------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.admin_settings s
   WHERE s.key = 'momo_first_claim_review' AND s.value = '{"value": true}'::jsonb AND length(coalesce(s.description, '')) > 10;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL setting_default: momo_first_claim_review is not {"value": true} with a description'; END IF;

  -- fn_catalog: same signature, SECURITY DEFINER, empty search_path, one overload, reads the setting ------------------
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid = v_fn::regprocedure AND p.prosecdef AND p.proconfig = ARRAY['search_path=""']
     AND pg_get_function_identity_arguments(p.oid) = 'p_txid text, p_user uuid, p_session_id uuid, p_check_amount boolean, p_mode text'
     AND pg_get_function_result(p.oid) = 'text';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL fn_catalog: claim_momo_transaction signature or security changed'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p WHERE p.proname = 'claim_momo_transaction';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL fn_catalog: % claim_momo_transaction functions (overloads?)', v_n; END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_fn::regprocedure;
  IF strpos(v_src, 'momo_first_claim_review') = 0 THEN RAISE EXCEPTION 'FAIL fn_catalog: the new body is not in place'; END IF;

  -- fn_grants: nobody may execute the internal function; the entry points are unchanged --------------------------------
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL fn_grants: someone can execute claim_momo_transaction';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn::regprocedure AND a.grantee = 0;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL fn_grants: PUBLIC has a privilege on claim_momo_transaction'; END IF;
  IF NOT has_function_privilege('service_role', 'public.claim_momo_via_session(uuid,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.claim_via_wallet_topup_session(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_momo_via_session(uuid,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL fn_grants: entry point grants changed';
  END IF;

  -- wallet_lock_first: the setting and every per-user check are read under the wallet lock -----------------------------
  IF strpos(v_src, 'FROM public.wallets w WHERE w.user_id = p_user FOR UPDATE') = 0
     OR strpos(v_src, 'FROM public.wallets w WHERE w.user_id = p_user FOR UPDATE') > strpos(v_src, 'momo_first_claim_review')
     OR strpos(v_src, 'FROM public.wallets w WHERE w.user_id = p_user FOR UPDATE') > strpos(v_src, 'momo_auto_claim_daily_cap') THEN
    RAISE EXCEPTION 'FAIL wallet_lock_first: the per-user checks are not under the wallet lock';
  END IF;

  -- review_on_flags_first_claim: default ON -> the claim box sends a first claim to review ----------------------------
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'QQR2222', 0.50, 0, 0.50, now() + interval '1 hour') RETURNING id INTO v_s;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('916100000001', 'selftest', 'pending', 0.50);
  v_res := public.claim_momo_via_session(v_user, '916100000001', v_s);
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '916100000001';
  IF v_res <> 'under_review' OR v_row.status <> 'flagged' OR v_row.flag_reasons <> ARRAY['first_claim'] OR v_row.claimed_by IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL review_on_flags_first_claim: % / % / %', v_res, v_row.status, v_row.flag_reasons;
  END IF;

  -- malformed_keeps_review: anything but an exact JSON false (and a missing row) keeps review on (webhook path) -------
  FOR v_i IN 1 .. cardinality(v_vals) LOOP
    IF v_vals[v_i] = 'MISSING' THEN
      DELETE FROM public.admin_settings s WHERE s.key = 'momo_first_claim_review';
    ELSE
      UPDATE public.admin_settings s SET value = v_vals[v_i]::jsonb WHERE s.key = 'momo_first_claim_review';
    END IF;
    v_code := 'QQQ62' || (v_i + 1)::text || '2';
    v_tx := '9161000001' || lpad(v_i::text, 2, '0');
    INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
    VALUES (v_user, v_code, 0.20, 0, 0.20, now() + interval '1 hour');
    INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES (v_tx, 'selftest', 'pending', 0.20);
    v_res := public.claim_via_wallet_topup_session(v_code, v_tx);
    SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = v_tx;
    IF v_res <> 'under_review' OR v_row.flag_reasons <> ARRAY['first_claim'] THEN
      RAISE EXCEPTION 'FAIL malformed_keeps_review: value % gave % / %', v_vals[v_i], v_res, v_row.flag_reasons;
    END IF;
  END LOOP;
  INSERT INTO public.admin_settings (key, value) VALUES ('momo_first_claim_review', '{"value": false}'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- off_above_threshold_still_flagged: review OFF, net 500.01 -> under_review with above_review_threshold only --------
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'QQR2223', 500.01, 0, 500.01, now() + interval '1 hour') RETURNING id INTO v_s;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('916100000002', 'selftest', 'pending', 500.01);
  v_res := public.claim_momo_via_session(v_user, '916100000002', v_s);
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '916100000002';
  IF v_res <> 'under_review' OR v_row.status <> 'flagged' OR v_row.flag_reasons <> ARRAY['above_review_threshold'] THEN
    RAISE EXCEPTION 'FAIL off_above_threshold_still_flagged: % / %', v_res, v_row.flag_reasons;
  END IF;
  SELECT w.balance INTO v_bal FROM public.wallets w WHERE w.user_id = v_user;
  IF v_bal <> v_bal0 THEN RAISE EXCEPTION 'FAIL off_above_threshold_still_flagged: wallet moved'; END IF;

  -- off_first_claim_credited: review OFF, first claim -> credited, wallet + net, one ledger row MOMO-<txid> -----------
  DELETE FROM public.momo_claim_attempts a WHERE a.user_id = v_user;
  INSERT INTO public.wallet_topup_sessions (user_id, code, amount, fee, net_amount, expires_at)
  VALUES (v_user, 'QQR2224', 0.40, 0, 0.40, now() + interval '1 hour') RETURNING id INTO v_s;
  INSERT INTO public.momo_transactions (transaction_id, raw_sms, status, amount) VALUES ('916100000003', 'selftest', 'pending', 0.40);
  v_res := public.claim_momo_via_session(v_user, '916100000003', v_s);
  IF v_res <> 'credited' THEN RAISE EXCEPTION 'FAIL off_first_claim_credited: %', v_res; END IF;
  SELECT * INTO v_row FROM public.momo_transactions m WHERE m.transaction_id = '916100000003';
  IF v_row.status <> 'claimed' OR v_row.claimed_by IS DISTINCT FROM v_user OR v_row.net_amount <> 0.40 OR cardinality(v_row.flag_reasons) <> 0 THEN
    RAISE EXCEPTION 'FAIL off_first_claim_credited: row % / %', v_row.status, v_row.flag_reasons;
  END IF;
  SELECT * INTO v_sess FROM public.wallet_topup_sessions s WHERE s.id = v_s;
  IF v_sess.status <> 'claimed' OR v_sess.claimed_transaction_id IS DISTINCT FROM '916100000003' THEN
    RAISE EXCEPTION 'FAIL off_first_claim_credited: session %', v_sess.status;
  END IF;
  SELECT w.balance INTO v_bal FROM public.wallets w WHERE w.user_id = v_user;
  IF v_bal <> v_bal0 + 0.40 THEN RAISE EXCEPTION 'FAIL off_first_claim_credited: balance % (was %)', v_bal, v_bal0; END IF;
  SELECT count(*) INTO v_n FROM public.transactions t
   WHERE t.reference_id = 'MOMO-916100000003' AND t.user_id = v_user AND t.type = 'credit' AND t.source = 'momo_claim'
     AND t.amount = 0.40 AND t.balance_before = v_bal0 AND t.balance_after = v_bal0 + 0.40 AND t.status = 'completed';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL off_first_claim_credited: % ledger rows', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.transactions t WHERE t.reference_id LIKE 'MOMO-91610000%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL off_first_claim_credited: % test ledger rows in all', v_n; END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0161 first-claim review toggle: default on, malformed stays on, off credits, other checks hold';
END $selftest$;
