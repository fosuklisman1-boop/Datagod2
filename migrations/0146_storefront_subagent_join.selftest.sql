-- 0146_storefront_subagent_join.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0146_storefront_subagent_join.sql.
--
-- IMPORTANT: build the run string by CODE (never by hand or a regex strip) and assert before sending that it
-- contains no COMMIT and no bare `END;` statement and ends with this DO block (which always RAISEs). (The
-- 0130 incident lesson.) Build it as:
--   1. BEGIN; followed by 0146_storefront_subagent_join.sql (the migration file has no transaction statements);
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward.
-- The DO body has no bare `END;`: sub-blocks are labelled and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new columns,
-- table, trigger and every test write are rolled back. PASSES when the error text starts with 'SELFTEST_OK';
-- any 'FAIL ...' or other error means it failed. If the client keeps the session open, send `ROLLBACK;`.
-- After the real apply the DO block can be run alone inside `BEGIN; ...` (never ended with a commit).
--
-- Scenarios (labels): catalog, joined_via_check, existing_sub_agent_default, setting_default,
-- intents_locked (read and write refused for authenticated and anon, real calls under SET LOCAL ROLE),
-- owner_blocked (is_active, joined_via, prices_set_at, dealer_rates_enabled), owner_allowed (an unprotected
-- column is still editable), service_unaffected.
--
-- Needs at least one existing user_shops row with a user_id (the owner), preferably a sub-agent shop
-- (parent_shop_id not null). "Owner" is simulated with SET LOCAL ROLE authenticated plus request.jwt.claims.

DO $selftest$
DECLARE
  v_shop    uuid;
  v_owner   uuid;
  v_subdef  boolean;
  v_n       int;
  v_got     text;
  v_called  boolean;
  v_role    text;
  v_seen    text;
  v_col     text;
  v_set     text;
  v_cnt     bigint;
BEGIN
  -- Setup -------------------------------------------------------------------
  SELECT s.id, s.user_id INTO v_shop, v_owner
    FROM public.user_shops s
   WHERE s.user_id IS NOT NULL
   ORDER BY (s.parent_shop_id IS NOT NULL) DESC, s.id
   LIMIT 1;
  IF v_shop IS NULL THEN
    RAISE EXCEPTION 'FAIL setup: no user_shops row with an owner';
  END IF;

  -- catalog -----------------------------------------------------------------
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'user_shops'
     AND ((column_name = 'joined_via' AND data_type = 'text' AND is_nullable = 'YES')
       OR (column_name = 'prices_set_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES')
       OR (column_name = 'dealer_rates_enabled' AND data_type = 'boolean' AND is_nullable = 'NO')
       OR (column_name = 'sub_agent_setup_alert_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES')
       OR (column_name = 'sub_agent_prices_ready_notified_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'));
  IF v_n <> 5 THEN RAISE EXCEPTION 'FAIL catalog: user_shops columns found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.user_shops'::regclass AND tgname = 'user_shops_protect_join_columns' AND NOT tgisinternal;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: protect trigger found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_class
   WHERE oid = 'public.sub_agent_join_intents'::regclass AND relrowsecurity;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL catalog: sub_agent_join_intents RLS is not enabled'; END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'sub_agent_join_intents';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL catalog: sub_agent_join_intents has % policies', v_n; END IF;

  -- joined_via only accepts 'storefront' (or NULL)
  v_got := NULL;
  <<joined_via_check>>
  BEGIN
    UPDATE public.user_shops SET joined_via = 'other' WHERE id = v_shop;
    v_got := 'NO_ERROR';
  EXCEPTION WHEN check_violation THEN
    v_got := 'check_violation';
  END joined_via_check;
  IF v_got <> 'check_violation' THEN RAISE EXCEPTION 'FAIL joined_via_check: %', v_got; END IF;

  -- existing_sub_agent_default: every existing shop (sub-agents included) reads true, no backfill needed
  SELECT s.dealer_rates_enabled INTO v_subdef
    FROM public.user_shops s
   WHERE s.parent_shop_id IS NOT NULL
   LIMIT 1;
  IF v_subdef IS NOT NULL AND v_subdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL existing_sub_agent_default: dealer_rates_enabled = %', v_subdef;
  END IF;
  SELECT count(*) INTO v_cnt FROM public.user_shops WHERE dealer_rates_enabled IS NOT TRUE;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'FAIL existing_sub_agent_default: % shops not true', v_cnt; END IF;

  -- setting_default: the singleton row reads false until an admin turns it on
  SELECT sub_agent_open_join_enabled::text INTO v_set FROM public.app_settings WHERE key IS NULL LIMIT 1;
  IF v_set IS NOT NULL AND v_set <> 'false' THEN
    RAISE EXCEPTION 'FAIL setting_default: sub_agent_open_join_enabled = %', v_set;
  END IF;

  -- intents_locked: a real read and a real write under each role are refused ------------------
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    v_called := false; v_got := NULL; v_seen := NULL;
    <<intents_read>>
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', v_role);
      v_seen := current_user;
      PERFORM 1 FROM public.sub_agent_join_intents LIMIT 1;
      v_called := true;
    EXCEPTION WHEN insufficient_privilege THEN
      v_got := SQLERRM;
    END intents_read;
    IF v_seen IS DISTINCT FROM v_role THEN
      RAISE EXCEPTION 'FAIL intents_locked: could not switch to % (current_user %, err %)', v_role, v_seen, v_got;
    END IF;
    IF v_called OR v_got IS NULL OR v_got NOT LIKE 'permission denied for table%' THEN
      RAISE EXCEPTION 'FAIL intents_locked read as %: called=% err=%', v_role, v_called, v_got;
    END IF;

    v_called := false; v_got := NULL; v_seen := NULL;
    <<intents_write>>
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', v_role);
      v_seen := current_user;
      INSERT INTO public.sub_agent_join_intents (user_id, parent_shop_id, shop_name, phone, nonce_hash)
        VALUES (v_owner, v_shop, 'selftest', '233249990146', 'selftest');
      v_called := true;
    EXCEPTION WHEN insufficient_privilege THEN
      v_got := SQLERRM;
    END intents_write;
    IF v_seen IS DISTINCT FROM v_role THEN
      RAISE EXCEPTION 'FAIL intents_locked: could not switch to % for write (current_user %)', v_role, v_seen;
    END IF;
    IF v_called OR v_got IS NULL OR v_got NOT LIKE 'permission denied for table%' THEN
      RAISE EXCEPTION 'FAIL intents_locked write as %: called=% err=%', v_role, v_called, v_got;
    END IF;
  END LOOP;
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'FAIL intents_locked: role did not revert (%)', current_user;
  END IF;

  -- owner_blocked: the shop owner (authenticated, own jwt) cannot change protected columns ----------
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  FOREACH v_col IN ARRAY ARRAY['is_active', 'joined_via', 'prices_set_at', 'dealer_rates_enabled',
                               'sub_agent_setup_alert_at', 'sub_agent_prices_ready_notified_at',
                               'is_blocked', 'block_reason', 'parent_shop_id', 'tier_level'] LOOP
    v_got := NULL; v_seen := NULL;
    <<owner_blocked>>
    BEGIN
      SET LOCAL ROLE authenticated;
      v_seen := current_user;
      IF v_col = 'is_active' THEN
        UPDATE public.user_shops SET is_active = NOT COALESCE(is_active, false) WHERE id = v_shop;
      ELSIF v_col = 'joined_via' THEN
        UPDATE public.user_shops SET joined_via = 'storefront' WHERE id = v_shop;
      ELSIF v_col = 'prices_set_at' THEN
        UPDATE public.user_shops SET prices_set_at = now() WHERE id = v_shop;
      ELSIF v_col = 'dealer_rates_enabled' THEN
        UPDATE public.user_shops SET dealer_rates_enabled = false WHERE id = v_shop;
      ELSIF v_col = 'sub_agent_setup_alert_at' THEN
        UPDATE public.user_shops SET sub_agent_setup_alert_at = now() WHERE id = v_shop;
      ELSIF v_col = 'sub_agent_prices_ready_notified_at' THEN
        UPDATE public.user_shops SET sub_agent_prices_ready_notified_at = now() WHERE id = v_shop;
      ELSIF v_col = 'is_blocked' THEN
        UPDATE public.user_shops SET is_blocked = NOT COALESCE(is_blocked, false) WHERE id = v_shop;
      ELSIF v_col = 'block_reason' THEN
        UPDATE public.user_shops SET block_reason = COALESCE(block_reason, '') || 'x' WHERE id = v_shop;
      ELSIF v_col = 'parent_shop_id' THEN
        UPDATE public.user_shops SET parent_shop_id = CASE WHEN parent_shop_id IS NULL THEN id ELSE NULL END WHERE id = v_shop;
      ELSE
        UPDATE public.user_shops SET tier_level = COALESCE(tier_level, 1) + 1 WHERE id = v_shop;
      END IF;
      v_got := 'NO_ERROR';
    EXCEPTION WHEN OTHERS THEN
      v_got := SQLERRM;
    END owner_blocked;
    IF v_seen IS DISTINCT FROM 'authenticated' THEN
      RAISE EXCEPTION 'FAIL owner_blocked %: could not switch role (current_user %, err %)', v_col, v_seen, v_got;
    END IF;
    IF v_got IS DISTINCT FROM 'protected shop columns cannot be changed by the shop owner' THEN
      RAISE EXCEPTION 'FAIL owner_blocked %: got % (NO_ERROR means the row was hidden by RLS or the trigger is missing)', v_col, v_got;
    END IF;
  END LOOP;
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'FAIL owner_blocked: role did not revert (%)', current_user;
  END IF;

  -- owner_allowed: an unprotected column is still editable by the owner (not a blanket block) -------
  v_got := NULL;
  <<owner_allowed>>
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE public.user_shops SET shop_name = shop_name WHERE id = v_shop;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_got := 'rows=' || v_n;
  EXCEPTION WHEN OTHERS THEN
    v_got := SQLERRM;
  END owner_allowed;
  RESET ROLE;
  IF v_got IS DISTINCT FROM 'rows=1' THEN
    RAISE EXCEPTION 'FAIL owner_allowed: %', v_got;
  END IF;

  -- service_unaffected: a service_role jwt can change the same columns -------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  UPDATE public.user_shops
     SET prices_set_at = now(), dealer_rates_enabled = false, joined_via = 'storefront'
   WHERE id = v_shop;
  SELECT count(*) INTO v_n FROM public.user_shops
   WHERE id = v_shop AND prices_set_at IS NOT NULL AND dealer_rates_enabled = false AND joined_via = 'storefront';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL service_unaffected: update did not apply (%)', v_n; END IF;

  -- Always roll back. -------------------------------------------------------
  RAISE EXCEPTION 'SELFTEST_OK 0146: all scenarios passed; rolling back';
END $selftest$;
