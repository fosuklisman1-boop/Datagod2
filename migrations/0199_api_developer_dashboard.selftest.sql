-- 0199_api_developer_dashboard.selftest.sql
-- Self-rolling-back check of migration 0199, appended by lib/api-v2/migration-0199-run.ts after the migration (minus its
-- final line). It always ends by raising SELFTEST_OK 0199, so the whole run string rolls back and nothing is left behind.
-- It sends nothing and deletes nothing that is not rolled back (no log row is 25 months old yet).
DO $selftest$
DECLARE
  v_ghost uuid := '00000000-0000-0000-0000-0000000001ff';
  r jsonb;
  n int;
BEGIN
  IF has_table_privilege('anon', 'public.api_v2_balance_alerts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.api_v2_balance_alerts', 'SELECT')
     OR has_function_privilege('authenticated', 'public.api_v2_dev_logs(uuid,jsonb,timestamptz,uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.api_v2_dev_orders(uuid,jsonb,timestamptz,text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.api_v2_dev_usage(uuid,integer,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.api_v2_balance_alert_scan(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL privileges';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'api_v2_balance_alerts') <> 0 THEN
    RAISE EXCEPTION 'FAIL policies';
  END IF;
  IF (SELECT count(*) FROM public.api_v2_balance_alerts) <> 0 THEN
    RAISE EXCEPTION 'FAIL alert table must start empty';
  END IF;

  -- A person with no keys and no orders sees nothing.
  r := public.api_v2_dev_usage(v_ghost, 7, NULL);
  IF jsonb_array_length(r->'daily') <> 7 OR r->'endpoints' <> '[]'::jsonb OR r->'orders' <> '{}'::jsonb THEN
    RAISE EXCEPTION 'FAIL usage for a person with nothing: %', r;
  END IF;
  IF public.api_v2_dev_logs(v_ghost, '{}'::jsonb, NULL, NULL, 50) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL logs for a person with nothing';
  END IF;
  IF public.api_v2_dev_orders(v_ghost, '{}'::jsonb, NULL, NULL, 50) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL orders for a person with nothing';
  END IF;

  -- Real data shape: the busiest developer's own rows read without error (counts only, nothing shown).
  PERFORM public.api_v2_dev_usage(k.user_id, 30, NULL) FROM public.api_v2_keys k
   GROUP BY k.user_id ORDER BY count(*) DESC LIMIT 1;
  PERFORM public.api_v2_dev_orders(o.user_id, '{}'::jsonb, NULL, NULL, 100) FROM public.api_orders o
   WHERE o.api_v2_key_id IS NOT NULL GROUP BY o.user_id ORDER BY count(*) DESC LIMIT 1;

  -- Alert round trip on a ghost user (no wallet row: never fires).
  r := public.api_v2_set_balance_alert(v_ghost, 25);
  IF (r->>'threshold')::numeric <> 25 OR NOT (r->>'armed')::boolean THEN
    RAISE EXCEPTION 'FAIL set alert: %', r;
  END IF;
  IF public.api_v2_balance_alert_scan(now()) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL scan must not fire without a wallet row';
  END IF;
  r := public.api_v2_set_balance_alert(v_ghost, NULL);
  IF NOT coalesce((r->>'removed')::boolean, false) THEN
    RAISE EXCEPTION 'FAIL remove alert';
  END IF;

  n := public.api_v2_logs_retention(now());
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL retention would delete % rows today', n;
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0199';
END
$selftest$;
