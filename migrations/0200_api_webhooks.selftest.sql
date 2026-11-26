-- 0200_api_webhooks.selftest.sql
-- Self-rolling-back check of migration 0200, appended by lib/api-v2/migration-0200-run.ts after the migration (minus its
-- final line). It always ends by raising SELFTEST_OK 0200, so the whole run string rolls back and nothing is left behind.
-- It sends nothing: no HTTP happens in SQL, and the events it queues for a ghost person roll back with everything else.
DO $selftest$
DECLARE
  v_ghost uuid := '00000000-0000-0000-0000-0000000002ff';
  v_secret text := 'whsec_' || repeat('Z', 43);
  r jsonb;
  v_id text;
  n int;
BEGIN
  IF has_table_privilege('anon', 'public.api_v2_webhook_endpoints', 'SELECT')
     OR has_table_privilege('authenticated', 'public.api_v2_webhook_events', 'SELECT')
     OR has_function_privilege('authenticated', 'public.api_v2_webhook_reveal(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.api_v2_webhook_claim(timestamptz,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.api_v2_webhook_scan(timestamptz,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.api_v2_webhook_record(text,integer,boolean,integer,integer,text,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL privileges';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename LIKE 'api_v2_webhook_%') <> 0 THEN
    RAISE EXCEPTION 'FAIL policies';
  END IF;
  IF (SELECT enabled FROM public.api_v2_webhook_settings WHERE id = 1) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL switch must start off';
  END IF;
  IF (SELECT count(*) FROM public.api_v2_webhook_endpoints) <> 0 OR (SELECT count(*) FROM public.api_v2_webhook_events) <> 0 THEN
    RAISE EXCEPTION 'FAIL tables must start empty';
  END IF;

  -- Off: nothing is scanned, claimed or queued.
  IF public.api_v2_webhook_scan(NULL, 500) <> 0 OR public.api_v2_webhook_claim(NULL, 50) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL off must do nothing';
  END IF;

  -- A ghost endpoint round trip (rolled back).
  r := public.api_v2_webhook_set_endpoint(v_ghost, 'https://hooks.example.invalid/x', true, v_secret);
  IF (r->>'created')::boolean IS NOT TRUE OR r::text LIKE '%' || v_secret || '%' THEN
    RAISE EXCEPTION 'FAIL set endpoint: %', r;
  END IF;
  IF public.api_v2_webhook_reveal(v_ghost) <> v_secret THEN
    RAISE EXCEPTION 'FAIL reveal';
  END IF;
  IF (public.api_v2_webhook_enqueue_test(v_ghost, NULL)->>'error') <> 'disabled' THEN
    RAISE EXCEPTION 'FAIL test while off';
  END IF;
  UPDATE public.api_v2_webhook_settings SET enabled = true WHERE id = 1;
  n := public.api_v2_webhook_scan(NULL, 500);   -- the ghost has no orders
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL ghost scan found %', n;
  END IF;
  v_id := public.api_v2_webhook_enqueue_test(v_ghost, NULL)->>'id';
  r := public.api_v2_webhook_claim_one(v_ghost, v_id, NULL);
  IF r->>'secret' <> v_secret OR (r->>'attempt')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL claim one: %', r;
  END IF;
  IF public.api_v2_webhook_record(v_id, 1, false, 500, 5, 'HTTP 500', NULL, NULL)->>'state' <> 'failed' THEN
    RAISE EXCEPTION 'FAIL a test event gets one attempt';
  END IF;
  IF jsonb_array_length(public.api_v2_webhook_deliveries(v_ghost, NULL, NULL, 25)) <> 1 THEN
    RAISE EXCEPTION 'FAIL deliveries';
  END IF;
  IF (public.api_v2_webhook_delete_endpoint(v_ghost)->>'removed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL delete';
  END IF;
  r := public.api_v2_webhook_retention(NULL);
  IF (r->>'events')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL retention removed fresh events: %', r;
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0200';
END
$selftest$;
