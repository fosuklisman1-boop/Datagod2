-- 0204_ai_voice_queue.selftest.sql
-- Self-rolling-back check of migration 0204. For a prod dry run, concatenate it after the migration with BEGIN;/COMMIT;
-- removed. Always ends by raising SELFTEST_OK 0204 (or a FAIL message), so nothing it does is kept.
-- No nested BEGIN ... END blocks: the dry-run builder rejects any END; inside the self-test.
DO $selftest$
DECLARE
  v_status text;
  v_defs text;
BEGIN
  IF to_regclass('public.ai_voice_queue') IS NULL THEN RAISE EXCEPTION 'FAIL table missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='ai_voice_queue' AND indexname='ai_voice_queue_status_created_idx') THEN
    RAISE EXCEPTION 'FAIL index';
  END IF;

  -- One live place per identity (read from the catalog; no failing inserts needed).
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='ai_voice_queue'
                 AND indexname='ai_voice_queue_one_live_user_idx' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%waiting%admitted%') THEN
    RAISE EXCEPTION 'FAIL unique live user index';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='ai_voice_queue'
                 AND indexname='ai_voice_queue_one_live_device_idx' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%waiting%admitted%') THEN
    RAISE EXCEPTION 'FAIL unique live device index';
  END IF;

  -- A device ticket defaults to waiting.
  INSERT INTO public.ai_voice_queue (device_hash, context, mode) VALUES ('selftest0204', 'home', 'voice');
  SELECT status INTO v_status FROM public.ai_voice_queue WHERE device_hash = 'selftest0204';
  IF v_status IS DISTINCT FROM 'waiting' THEN RAISE EXCEPTION 'FAIL default status'; END IF;

  -- The CHECK constraints are in place (read from the catalog; no failing inserts needed).
  SELECT string_agg(pg_get_constraintdef(oid), ' | ') INTO v_defs
    FROM pg_constraint WHERE conrelid = 'public.ai_voice_queue'::regclass AND contype = 'c';
  IF v_defs NOT LIKE '%user_id IS NOT NULL%device_hash IS NOT NULL%' THEN RAISE EXCEPTION 'FAIL identity check'; END IF;
  IF v_defs NOT LIKE '%waiting%admitted%used%left%expired%' THEN RAISE EXCEPTION 'FAIL status check'; END IF;
  IF v_defs NOT LIKE '%home%storefront%dashboard%admin%' THEN RAISE EXCEPTION 'FAIL context check'; END IF;
  IF v_defs NOT LIKE '%voice%video%' THEN RAISE EXCEPTION 'FAIL mode check'; END IF;

  -- RLS on, client roles have no access.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_voice_queue'::regclass) THEN RAISE EXCEPTION 'FAIL rls'; END IF;
  IF has_table_privilege('anon', 'public.ai_voice_queue', 'SELECT') OR has_table_privilege('authenticated', 'public.ai_voice_queue', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL privileges';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.ai_voice_queue', 'SELECT') THEN RAISE EXCEPTION 'FAIL service_role'; END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0204';
END
$selftest$;
