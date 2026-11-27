-- 0202_ai_voice_calls_nuance_key.selftest.sql
-- Self-rolling-back check of migration 0202. For a prod dry run, concatenate it after the migration with BEGIN;/COMMIT;
-- removed. Always ends by raising SELFTEST_OK 0202 (or a FAIL message), so nothing it does is kept.
DO $selftest$
DECLARE
  v_ok boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='ai_voice_calls' AND column_name='nuance_key' AND data_type='smallint') THEN
    RAISE EXCEPTION 'FAIL nuance_key column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='ai_voice_calls' AND indexname='ai_voice_calls_open_key_idx') THEN
    RAISE EXCEPTION 'FAIL open key index';
  END IF;

  -- In range and NULL are accepted.
  INSERT INTO public.ai_voice_calls (context, mode, persona_id, max_seconds, device_hash, nuance_key)
    VALUES ('home', 'voice', 'sam', 120, 'selftest0202', 3);
  INSERT INTO public.ai_voice_calls (context, mode, persona_id, max_seconds, device_hash)
    VALUES ('home', 'voice', 'sam', 120, 'selftest0202');

  -- Out of range is refused.
  v_ok := false;
  BEGIN
    INSERT INTO public.ai_voice_calls (context, mode, persona_id, max_seconds, device_hash, nuance_key)
      VALUES ('home', 'voice', 'sam', 120, 'selftest0202', 10);
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL range check'; END IF;

  -- Client roles still have no access.
  IF has_table_privilege('anon', 'public.ai_voice_calls', 'SELECT') OR has_table_privilege('authenticated', 'public.ai_voice_calls', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL privileges';
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0202';
END
$selftest$;
