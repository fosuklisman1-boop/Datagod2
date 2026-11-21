-- 0188_ai_confirm_cards.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0188_ai_confirm_cards.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and that this DO block has no bare
-- `END;` statement and ends by raising. (The 0130 incident lesson.) Build it as lib/ai-drafts/migration-0188-run.ts does:
--   1. 0188_ai_confirm_cards.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: nested blocks are labelled (`END b_x;`) and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new objects and every test
-- write below are undone. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send `ROLLBACK;`.
--
-- Checks: ai_drafts exists with RLS on and no anon / authenticated privilege; invalid status / action / context are refused;
-- orders.idempotency_key is unique when set and free when NULL (uses two EXISTING orders rows, skipped if fewer than two,
-- so nothing is inserted into orders); revert_wallet_deduction adds back exactly the amount after an interleaved sequence
-- (uses one EXISTING wallets row, skipped if none) and refuses a bad amount / missing wallet; anon / authenticated cannot
-- EXECUTE it; the ai_scheduled_tasks columns exist; the standing-order guard trigger exists and, as authenticated, refuses
-- an INSERT / UPDATE of a server-only column with STANDING_ORDER_SERVER_ONLY while not blocking an unrelated UPDATE
-- (UPDATE checks use one EXISTING ai_scheduled_tasks row, skipped if none; RLS hiding the row counts as not changed).

DO $selftest$
DECLARE
  v_n     int;
  v_who   text;
  v_c1    tid;
  v_c2    tid;
  v_uid   uuid;
  v_task  uuid;
  v_key   uuid := gen_random_uuid();
  v_bal   numeric;
  v_state boolean;
BEGIN
  -- table, RLS, client privileges
  IF to_regclass('public.ai_drafts') IS NULL THEN RAISE EXCEPTION 'FAIL table_missing ai_drafts'; END IF;
  IF NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_drafts'::regclass), false) THEN
    RAISE EXCEPTION 'FAIL rls_not_enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_drafts') THEN
    RAISE EXCEPTION 'FAIL ai_drafts_has_policy';
  END IF;
  FOREACH v_who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_who, 'public.ai_drafts', 'SELECT') OR has_table_privilege(v_who, 'public.ai_drafts', 'INSERT')
       OR has_table_privilege(v_who, 'public.ai_drafts', 'UPDATE') OR has_table_privilege(v_who, 'public.ai_drafts', 'DELETE') THEN
      RAISE EXCEPTION 'FAIL client_role_has_privilege % ai_drafts', v_who;
    END IF;
  END LOOP;

  -- checks refuse bad values (check_violation is raised before the FK is evaluated)
  <<b_status>>
  BEGIN
    INSERT INTO public.ai_drafts (user_id, context, action, params, display, status, expires_at)
      VALUES (gen_random_uuid(), 'dashboard', 'wallet_order', '{}', '{}', 'bogus', now() + interval '10 minutes');
    RAISE EXCEPTION 'FAIL bad_status_accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END b_status;
  <<b_action>>
  BEGIN
    INSERT INTO public.ai_drafts (user_id, context, action, params, display, expires_at)
      VALUES (gen_random_uuid(), 'dashboard', 'drop_everything', '{}', '{}', now() + interval '10 minutes');
    RAISE EXCEPTION 'FAIL bad_action_accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END b_action;
  <<b_context>>
  BEGIN
    INSERT INTO public.ai_drafts (user_id, context, action, params, display, expires_at)
      VALUES (gen_random_uuid(), 'nowhere', 'wallet_order', '{}', '{}', now() + interval '10 minutes');
    RAISE EXCEPTION 'FAIL bad_context_accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END b_context;

  -- orders.idempotency_key: unique when set, free when NULL
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'orders_idempotency_key_uniq'
                  AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%WHERE%idempotency_key IS NOT NULL%') THEN
    RAISE EXCEPTION 'FAIL idempotency_index_missing';
  END IF;
  SELECT count(*) INTO v_n FROM (SELECT 1 FROM public.orders LIMIT 2) s;
  IF v_n >= 2 THEN
    SELECT ctid INTO v_c1 FROM public.orders ORDER BY ctid LIMIT 1;
    SELECT ctid INTO v_c2 FROM public.orders WHERE ctid <> v_c1 ORDER BY ctid LIMIT 1;
    -- the column is new, so every row is NULL: two NULLs coexist. Only c1 is rewritten, so c2's ctid stays valid.
    UPDATE public.orders SET idempotency_key = v_key WHERE ctid = v_c1;
    <<b_dup>>
    BEGIN
      UPDATE public.orders SET idempotency_key = v_key WHERE ctid = v_c2;
      RAISE EXCEPTION 'FAIL duplicate_idempotency_key_accepted';
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END b_dup;
  END IF;

  -- ai_scheduled_tasks columns
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'ai_scheduled_tasks'
     AND column_name IN ('standing_order', 'approved_draft_id', 'consecutive_skips');
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL ai_scheduled_tasks_columns %', v_n; END IF;

  -- delete actions (catalog only, no writes): removing a user cascades to their drafts; removing a draft nulls a task link
  SELECT count(*) INTO v_n FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.contype = 'f' AND c.conrelid = 'public.ai_drafts'::regclass AND a.attname = 'user_id' AND c.confdeltype = 'c';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL ai_drafts_user_fk_not_cascade'; END IF;
  SELECT count(*) INTO v_n FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.contype = 'f' AND c.conrelid = 'public.ai_scheduled_tasks'::regclass AND a.attname = 'approved_draft_id' AND c.confdeltype = 'n';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL approved_draft_fk_not_set_null'; END IF;

  -- standing-order guard trigger: server-only columns
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ai_scheduled_tasks'::regclass
                  AND tgname = 'ai_scheduled_tasks_guard_standing_order' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL guard_trigger_missing';
  END IF;
  FOREACH v_who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(v_who, 'public.ai_scheduled_tasks_guard_standing_order()', 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL client_can_execute_guard %', v_who;
    END IF;
  END LOOP;
  SELECT id INTO v_task FROM public.ai_scheduled_tasks ORDER BY id LIMIT 1;
  -- a client INSERT that sets a server-only column is refused by the guard (the BEFORE trigger runs before the RLS check)
  <<b_guard_ins>>
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.ai_scheduled_tasks (name, prompt, context, schedule_type, next_run_at, standing_order)
      VALUES ('selftest', 'selftest', 'dashboard', 'once', now(), '{"x":1}');
    RESET ROLE;
    RAISE EXCEPTION 'FAIL client_insert_standing_order_accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    -- the guard, or (prod: authenticated has SELECT only on this table) a plain privilege refusal; both are a refusal
    IF SQLERRM NOT LIKE 'STANDING_ORDER_SERVER_ONLY%' AND SQLERRM NOT LIKE 'permission denied%' THEN RAISE EXCEPTION 'FAIL insert_refused_by_other_than_guard: %', SQLERRM; END IF;
  END b_guard_ins;
  IF v_task IS NOT NULL THEN
    -- a client UPDATE of a server-only column: refused by the guard, or the row is hidden by RLS (0 rows, nothing changed)
    <<b_guard_upd>>
    BEGIN
      SET LOCAL ROLE authenticated;
      UPDATE public.ai_scheduled_tasks SET standing_order = '{"x":1}' WHERE id = v_task;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RESET ROLE;
      IF v_n > 0 THEN RAISE EXCEPTION 'FAIL client_update_standing_order_accepted'; END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
      IF SQLERRM NOT LIKE 'STANDING_ORDER_SERVER_ONLY%' AND SQLERRM NOT LIKE 'permission denied%' THEN RAISE EXCEPTION 'FAIL update_refused_by_other_than_guard: %', SQLERRM; END IF;
    END b_guard_upd;
    -- a client UPDATE of an unrelated column is never blocked by the guard (RLS or grants may still refuse it)
    <<b_guard_other>>
    BEGIN
      SET LOCAL ROLE authenticated;
      UPDATE public.ai_scheduled_tasks SET name = name WHERE id = v_task;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      IF SQLERRM LIKE 'STANDING_ORDER_SERVER_ONLY%' THEN RAISE EXCEPTION 'FAIL guard_blocks_unrelated_update'; END IF;
    END b_guard_other;
    -- the server (this session's role) can set it
    UPDATE public.ai_scheduled_tasks SET standing_order = '{"x":1}', consecutive_skips = 2 WHERE id = v_task;
  END IF;

  -- revert_wallet_deduction: closed to clients
  IF to_regprocedure('public.revert_wallet_deduction(uuid,numeric)') IS NULL THEN RAISE EXCEPTION 'FAIL function_missing'; END IF;
  FOREACH v_who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(v_who, 'public.revert_wallet_deduction(uuid,numeric)', 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL client_can_execute %', v_who;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.revert_wallet_deduction(uuid,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL service_role_cannot_execute';
  END IF;
  SELECT prosecdef INTO v_state FROM pg_proc WHERE oid = 'public.revert_wallet_deduction(uuid,numeric)'::regprocedure;
  IF NOT v_state THEN RAISE EXCEPTION 'FAIL not_security_definer'; END IF;

  -- refusals
  <<b_zero>>
  BEGIN
    PERFORM public.revert_wallet_deduction(gen_random_uuid(), 0);
    RAISE EXCEPTION 'FAIL zero_amount_accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  END b_zero;
  <<b_nowallet>>
  BEGIN
    PERFORM public.revert_wallet_deduction(gen_random_uuid(), 5);
    RAISE EXCEPTION 'FAIL missing_wallet_accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  END b_nowallet;

  -- interleaved sequence on one existing wallet (rolled back with everything else)
  SELECT user_id INTO v_uid FROM public.wallets ORDER BY user_id LIMIT 1;
  IF v_uid IS NOT NULL THEN
    UPDATE public.wallets SET balance = 100, total_spent = 50 WHERE user_id = v_uid;
    UPDATE public.wallets SET balance = balance - 20, total_spent = total_spent + 20 WHERE user_id = v_uid;
    UPDATE public.wallets SET balance = balance - 10, total_spent = total_spent + 10 WHERE user_id = v_uid;
    v_bal := public.revert_wallet_deduction(v_uid, 20);
    IF v_bal <> 90 THEN RAISE EXCEPTION 'FAIL revert_balance % (want 90)', v_bal; END IF;
    SELECT count(*) INTO v_n FROM public.wallets WHERE user_id = v_uid AND balance = 90 AND total_spent = 60;
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL revert_total_spent'; END IF;
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0188 (rolled back)';
END $selftest$;
