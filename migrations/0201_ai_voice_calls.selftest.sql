-- 0201_ai_voice_calls.selftest.sql
-- Self-rolling-back check of migration 0201. Run after the migration. It always ends by raising SELFTEST_OK 0201 (or
-- fails earlier with a FAIL message), so nothing is left behind.
DO $selftest$
DECLARE
  v_ok boolean;
  v_ghost uuid := '00000000-0000-0000-0000-0000000002a1';
BEGIN
  -- Access: service role only, RLS on, no policies.
  IF has_table_privilege('anon', 'public.ai_voice_calls', 'SELECT')
     OR has_table_privilege('anon', 'public.ai_voice_calls', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_voice_calls', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ai_voice_calls', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_voice_calls', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ai_voice_calls', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.ai_voice_calls', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL privileges';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.ai_voice_calls'::regclass) THEN
    RAISE EXCEPTION 'FAIL rls off';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'ai_voice_calls') <> 0 THEN
    RAISE EXCEPTION 'FAIL policies';
  END IF;

  -- The three indexes.
  IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ai_voice_calls'
        AND indexname IN ('ai_voice_calls_user_idx', 'ai_voice_calls_device_idx', 'ai_voice_calls_context_idx')) <> 3 THEN
    RAISE EXCEPTION 'FAIL indexes';
  END IF;

  -- A call with neither a user nor a device is refused.
  v_ok := false;
  BEGIN
    INSERT INTO public.ai_voice_calls (context, mode, persona_id, max_seconds) VALUES ('home', 'voice', 'p', 60);
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL identity check';
  END IF;

  -- Bad context / mode are refused.
  v_ok := false;
  BEGIN
    INSERT INTO public.ai_voice_calls (device_hash, context, mode, persona_id, max_seconds) VALUES ('d', 'nowhere', 'voice', 'p', 60);
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL context check';
  END IF;
  v_ok := false;
  BEGIN
    INSERT INTO public.ai_voice_calls (device_hash, context, mode, persona_id, max_seconds) VALUES ('d', 'home', 'text', 'p', 60);
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL mode check';
  END IF;

  -- Valid rows (device-only, and user-based) are accepted.
  INSERT INTO public.ai_voice_calls (device_hash, context, mode, persona_id, max_seconds) VALUES ('d', 'storefront', 'video', 'p', 60);
  INSERT INTO auth.users (id) VALUES (v_ghost);
  INSERT INTO public.ai_voice_calls (user_id, context, mode, persona_id, max_seconds) VALUES (v_ghost, 'admin', 'voice', 'p', 120);
  -- Deleting the user cascades to their calls.
  DELETE FROM auth.users WHERE id = v_ghost;
  IF EXISTS (SELECT 1 FROM public.ai_voice_calls WHERE user_id = v_ghost) THEN
    RAISE EXCEPTION 'FAIL cascade';
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0201';
END
$selftest$;
