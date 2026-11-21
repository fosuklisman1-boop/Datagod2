-- 0189_ai_conversations.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0189_ai_conversations.sql.
--
-- IMPORTANT: the run string must be built by CODE (lib/ai-console/migration-0189-run.ts), never by hand: it keeps BEGIN and
-- both SET LOCALs, removes ONLY the final COMMIT line, then appends this file from the line that STARTS (column 0) with
-- the DO keyword onward; the code asserts no COMMIT and no bare END; and that it ends by raising. (The 0130 lesson.)
-- The DO body has no bare end statement: nested blocks are labelled and the block closes with the labelled dollar tag.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new tables and every test
-- write are undone. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send ROLLBACK.
--
-- Checks: both tables exist with RLS on and no anon / authenticated privilege; invalid context / role are refused; the
-- conversation key is unique; messages cascade with their conversation; deleting a user cascades their conversations.

DO $selftest$
DECLARE
  v_n    int;
  v_u    uuid := gen_random_uuid();
  v_key  uuid := gen_random_uuid();
  v_c    uuid;
  v_t    text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['ai_conversations','ai_conversation_messages'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN RAISE EXCEPTION 'FAIL missing_table %', v_t; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass) THEN RAISE EXCEPTION 'FAIL rls_off %', v_t; END IF;
    IF has_table_privilege('anon', 'public.' || v_t, 'SELECT') OR has_table_privilege('anon', 'public.' || v_t, 'INSERT') THEN RAISE EXCEPTION 'FAIL anon_priv %', v_t; END IF;
    IF has_table_privilege('authenticated', 'public.' || v_t, 'SELECT') OR has_table_privilege('authenticated', 'public.' || v_t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || v_t, 'UPDATE') OR has_table_privilege('authenticated', 'public.' || v_t, 'DELETE') THEN
      RAISE EXCEPTION 'FAIL authenticated_priv %', v_t;
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || v_t, 'INSERT') THEN RAISE EXCEPTION 'FAIL service_role_priv %', v_t; END IF;
  END LOOP;

  INSERT INTO public.users(id) VALUES (v_u);
  INSERT INTO public.ai_conversations(conversation_key, context, user_id) VALUES (v_key, 'dashboard', v_u) RETURNING id INTO v_c;

  <<b_ctx>>
  BEGIN
    INSERT INTO public.ai_conversations(conversation_key, context) VALUES (gen_random_uuid(), 'whatsapp');
    RAISE EXCEPTION 'FAIL bad_context_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END b_ctx;

  <<b_dup>>
  BEGIN
    INSERT INTO public.ai_conversations(conversation_key, context) VALUES (v_key, 'home');
    RAISE EXCEPTION 'FAIL duplicate_key_accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END b_dup;

  <<b_role>>
  BEGIN
    INSERT INTO public.ai_conversation_messages(conversation_id, role, text) VALUES (v_c, 'system', 'x');
    RAISE EXCEPTION 'FAIL bad_role_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END b_role;

  INSERT INTO public.ai_conversation_messages(conversation_id, role, text) VALUES (v_c, 'user', 'hi'), (v_c, 'assistant', 'hello');
  SELECT count(*) INTO v_n FROM public.ai_conversation_messages WHERE conversation_id = v_c;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL messages_not_stored'; END IF;

  DELETE FROM public.ai_conversations WHERE id = v_c;
  SELECT count(*) INTO v_n FROM public.ai_conversation_messages WHERE conversation_id = v_c;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL messages_not_cascaded'; END IF;

  INSERT INTO public.ai_conversations(conversation_key, context, user_id) VALUES (gen_random_uuid(), 'dashboard', v_u);
  DELETE FROM public.users WHERE id = v_u;
  SELECT count(*) INTO v_n FROM public.ai_conversations WHERE user_id = v_u;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL user_not_cascaded'; END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0189 (rolled back)';
END $selftest$;
