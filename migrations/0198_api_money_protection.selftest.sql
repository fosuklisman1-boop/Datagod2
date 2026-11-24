-- 0198_api_money_protection.selftest.sql
-- Self-rolling-back check of migration 0198, appended by lib/api-v2/migration-0198-run.ts after the migration (minus its
-- final line). It always ends by raising SELFTEST_OK 0198, so the whole run string rolls back and nothing is left behind.
-- It switches caps on only inside this transaction, and only exercises an existing live key (none -> that part is skipped).
DO $selftest$
DECLARE
  v_caps boolean;
  v_alerts boolean;
  v_key uuid;
  v_user uuid;
  r jsonb;
BEGIN
  SELECT s.caps_enabled, s.alerts_enabled INTO v_caps, v_alerts FROM public.api_v2_money_settings s WHERE s.id = 1;
  IF v_caps IS NULL OR v_caps OR v_alerts THEN
    RAISE EXCEPTION 'FAIL settings: switches must be seeded off';
  END IF;
  IF has_table_privilege('anon', 'public.api_v2_spend_ledger', 'SELECT')
     OR has_table_privilege('authenticated', 'public.api_v2_spend_caps', 'SELECT')
     OR has_function_privilege('authenticated', 'public.api_v2_spend_reserve(uuid,uuid,text,text,numeric)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.api_v2_spend_reserve(uuid,uuid,text,text,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL privileges';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename IN ('api_v2_money_settings', 'api_v2_spend_caps', 'api_v2_spend_ledger', 'api_v2_risk_alerts')) <> 0 THEN
    RAISE EXCEPTION 'FAIL policies';
  END IF;
  IF public.api_v2_risk_scan(NULL) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL risk_scan must be empty while alerts are off';
  END IF;

  SELECT k.id, k.user_id INTO v_key, v_user FROM public.api_v2_keys k WHERE k.environment = 'live' LIMIT 1;
  IF v_key IS NULL THEN
    RAISE NOTICE 'no live key: reserve checks skipped';
  ELSE
    r := public.api_v2_spend_reserve(v_user, v_key, 'data', 'selftest-0198-a', 0.60);
    IF r <> jsonb_build_object('ok', true, 'skipped', true) THEN
      RAISE EXCEPTION 'FAIL reserve with caps off: %', r;
    END IF;
    UPDATE public.api_v2_money_settings SET caps_enabled = true WHERE id = 1;
    DELETE FROM public.api_v2_spend_caps WHERE scope = 'user' AND scope_id = v_user;
    INSERT INTO public.api_v2_spend_caps(scope, scope_id, daily_cap, set_by)
    SELECT 'key', v_key, coalesce(sum(l.amount), 0) + 1.00, v_user
      FROM public.api_v2_spend_ledger l
     WHERE l.key_id = v_key AND l.day = (now() AT TIME ZONE 'UTC')::date AND l.state IN ('reserved', 'spent')
    ON CONFLICT (scope, scope_id) DO UPDATE SET daily_cap = EXCLUDED.daily_cap;
    r := public.api_v2_spend_reserve(v_user, v_key, 'data', 'selftest-0198-a', 0.60);
    IF NOT (r->>'ok')::boolean THEN
      RAISE EXCEPTION 'FAIL first reserve: %', r;
    END IF;
    r := public.api_v2_spend_reserve(v_user, v_key, 'data', 'selftest-0198-b', 0.60);
    IF r <> jsonb_build_object('ok', false, 'code', 'cap_reached', 'scope', 'key') THEN
      RAISE EXCEPTION 'FAIL cap: %', r;
    END IF;
    r := public.api_v2_spend_settle(v_key, 'data', 'selftest-0198-a', 'released', NULL);
    IF r <> jsonb_build_object('ok', true, 'changed', true) THEN
      RAISE EXCEPTION 'FAIL settle: %', r;
    END IF;
    r := public.api_v2_spend_reserve(v_user, v_key, 'data', 'selftest-0198-b', 0.60);
    IF NOT (r->>'ok')::boolean THEN
      RAISE EXCEPTION 'FAIL reserve after release: %', r;
    END IF;
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0198';
END $selftest$;
