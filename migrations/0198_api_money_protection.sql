-- 0198_api_money_protection.sql
--
-- API v2 Release 5 (money protection): daily spending caps on live keys (developer per key, admin per person, the stricter
-- wins) enforced by a spend ledger, and a risk scan feeding admin alerts. Spec: docs/superpowers/specs/2026-11-24-api-money-r5-design.md.
--
-- ADDITIVE and DARK: four new service-role-only tables and six SECURITY DEFINER functions. Both switches are seeded OFF
-- (caps_enabled = false, alerts_enabled = false), so applying this changes no behaviour. No existing table is altered and
-- no foreign key is created (a foreign key to api_v2_keys would lock that busy table until the transaction ends).
-- One transaction. Idempotent (IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING for the settings seed).
--
-- Tables
--   api_v2_money_settings   id = 1 singleton: caps_enabled, alerts_enabled, thresholds (risk scan), updated_at, updated_by.
--   api_v2_spend_caps       (scope 'key'|'user', scope_id) -> daily_cap GHS (> 0, <= 1000000). No row = no limit at that level.
--   api_v2_spend_ledger     one row per live purchase reserve: (key_id, kind, reference) unique, day (UTC = Ghana time), amount,
--                           state reserved | spent | released. Reserved and spent count toward today's spend; released does not.
--   api_v2_risk_alerts      dedup record of risk alerts: UNIQUE (user_id, signal, bucket); details hold numbers only.
--
-- Functions (service_role EXECUTE only; search_path pinned to public, pg_temp)
--   api_v2_spend_reserve(user, key, kind, reference, amount)  per-user advisory lock, then sum and compare with both caps.
--   api_v2_spend_settle(key, kind, reference, state, amount)  reserved -> spent (amount may only drop) or -> released.
--   api_v2_set_spend_cap(scope, scope_id, cap, actor)         audited; key scope checks owner = actor and a live key.
--   api_v2_set_money_settings(caps, alerts, thresholds, actor) audited; thresholds merged into the stored object.
--   api_v2_spend_today(user)                                  today's spend and caps per key and per person, refusals today.
--   api_v2_risk_scan(now)                                     candidate alerts for five signals; [] while alerts are off.
--
-- LOCKS: only the new objects. Every lock is held until the transaction ends. lock_timeout 2s bounds only the wait; a lock
-- timeout (SQLSTATE 55P03) is harmless and safe to retry (nothing is applied). Any quiet window is fine.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.api_v2_money_settings'), to_regclass('public.api_v2_spend_caps'),
--          to_regclass('public.api_v2_spend_ledger'), to_regclass('public.api_v2_risk_alerts');            -- NULL x4
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
--      AND p.proname IN ('api_v2_spend_reserve','api_v2_spend_settle','api_v2_set_spend_cap','api_v2_set_money_settings',
--      'api_v2_spend_today','api_v2_risk_scan');                                                            -- 0
--   SELECT to_regclass('public.admin_audit_log');                                                         -- NOT NULL
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_v2_logs'
--      AND column_name = 'error_reason';                                                                  -- 1 row (0195)
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_v2_keys'
--      AND column_name IN ('environment','user_id','created_at');                                         -- 3 rows
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_orders'
--      AND column_name IN ('api_v2_key_id','price','status','recipient_phone','created_at');               -- 5 rows
--
-- VERIFY after applying:
--   SELECT has_table_privilege('anon','public.api_v2_spend_ledger','SELECT'),
--          has_function_privilege('authenticated','public.api_v2_spend_reserve(uuid,uuid,text,text,numeric)','EXECUTE'),
--          has_function_privilege('service_role','public.api_v2_spend_reserve(uuid,uuid,text,text,numeric)','EXECUTE');  -- false, false, true
--   SELECT count(*) FROM pg_policies WHERE tablename IN ('api_v2_money_settings','api_v2_spend_caps','api_v2_spend_ledger','api_v2_risk_alerts'); -- 0
--   SELECT caps_enabled, alerts_enabled FROM public.api_v2_money_settings;                                 -- false, false
--
-- Dry run: migrations/0198_api_money_protection.selftest.sql through lib/api-v2/migration-0198-run.ts (never by hand).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

-- ============ 1. functions (plpgsql: none needs a table at create time) ============

CREATE OR REPLACE FUNCTION public.api_v2_spend_reserve(p_user uuid, p_key uuid, p_kind text, p_reference text, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_day date := (now() AT TIME ZONE 'UTC')::date;
  v_caps boolean;
  v_amt numeric := round(p_amount, 2);
  v_existing uuid;
  v_state text;
  v_key_cap numeric;
  v_user_cap numeric;
  v_key_sum numeric;
  v_user_sum numeric;
  v_id uuid;
BEGIN
  IF p_user IS NULL OR p_key IS NULL OR p_reference IS NULL OR char_length(p_reference) NOT BETWEEN 1 AND 200
     OR v_amt IS NULL OR v_amt <= 0 OR v_amt > 1000000
     OR p_kind IS NULL OR p_kind NOT IN ('data', 'data_bulk', 'airtime', 'bill', 'bundle', 'results', 'afa') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_input');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.api_v2_keys k WHERE k.id = p_key AND k.user_id = p_user AND k.environment = 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_input');
  END IF;

  SELECT s.caps_enabled INTO v_caps FROM public.api_v2_money_settings s WHERE s.id = 1;
  IF NOT coalesce(v_caps, false) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true);
  END IF;

  -- One person's reserves run one at a time: parallel requests can never together pass a cap.
  PERFORM pg_advisory_xact_lock(hashtextextended('api_v2_spend:' || p_user::text, 0));

  -- A reserved or spent row for this reference is handed back as `existing` (another request owns it: the caller must
  -- never settle it). A RELEASED row is not a free pass: it is re-checked against the caps below and revived.
  SELECT l.id, l.state INTO v_existing, v_state FROM public.api_v2_spend_ledger l
   WHERE l.key_id = p_key AND l.kind = p_kind AND l.reference = p_reference;
  IF v_existing IS NOT NULL AND v_state IN ('reserved', 'spent') THEN
    RETURN jsonb_build_object('ok', true, 'ledger_id', v_existing, 'existing', true, 'state', v_state);
  END IF;

  SELECT c.daily_cap INTO v_key_cap FROM public.api_v2_spend_caps c WHERE c.scope = 'key' AND c.scope_id = p_key;
  SELECT c.daily_cap INTO v_user_cap FROM public.api_v2_spend_caps c WHERE c.scope = 'user' AND c.scope_id = p_user;

  SELECT coalesce(sum(l.amount) FILTER (WHERE l.key_id = p_key), 0), coalesce(sum(l.amount), 0)
    INTO v_key_sum, v_user_sum
    FROM public.api_v2_spend_ledger l
   WHERE l.user_id = p_user AND l.day = v_day AND l.state IN ('reserved', 'spent');

  IF v_key_cap IS NOT NULL AND v_key_sum + v_amt > v_key_cap THEN
    RETURN jsonb_build_object('ok', false, 'code', 'cap_reached', 'scope', 'key');
  END IF;
  IF v_user_cap IS NOT NULL AND v_user_sum + v_amt > v_user_cap THEN
    RETURN jsonb_build_object('ok', false, 'code', 'cap_reached', 'scope', 'user');
  END IF;

  IF v_existing IS NOT NULL THEN
    -- revive a released row: it counts again from today, for this amount
    UPDATE public.api_v2_spend_ledger
       SET state = 'reserved', amount = v_amt, day = v_day, updated_at = now()
     WHERE id = v_existing AND state = 'released';
    RETURN jsonb_build_object('ok', true, 'ledger_id', v_existing);
  END IF;

  INSERT INTO public.api_v2_spend_ledger(user_id, key_id, day, kind, reference, amount, state)
  VALUES (p_user, p_key, v_day, p_kind, p_reference, v_amt, 'reserved')
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'ledger_id', v_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_spend_reserve(uuid, uuid, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_spend_reserve(uuid, uuid, text, text, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.api_v2_spend_settle(p_key uuid, p_kind text, p_reference text, p_state text, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_n int;
BEGIN
  IF p_key IS NULL OR p_kind IS NULL OR p_reference IS NULL OR p_state IS NULL OR p_state NOT IN ('spent', 'released') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_input');
  END IF;
  UPDATE public.api_v2_spend_ledger l
     SET state = p_state,
         amount = CASE WHEN p_state = 'spent' AND p_amount IS NOT NULL THEN least(l.amount, greatest(round(p_amount, 2), 0)) ELSE l.amount END,
         updated_at = now()
   WHERE l.key_id = p_key AND l.kind = p_kind AND l.reference = p_reference AND l.state = 'reserved';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'changed', v_n > 0);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_spend_settle(uuid, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_spend_settle(uuid, text, text, text, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.api_v2_set_spend_cap(p_scope text, p_scope_id uuid, p_cap numeric, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_target uuid;
  v_env text;
  v_old numeric;
BEGIN
  IF p_actor IS NULL OR p_scope_id IS NULL OR p_scope IS NULL OR p_scope NOT IN ('key', 'user')
     OR (p_cap IS NOT NULL AND (round(p_cap, 2) <= 0 OR p_cap > 1000000)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_input');
  END IF;
  IF p_scope = 'key' THEN
    SELECT k.user_id, k.environment INTO v_target, v_env FROM public.api_v2_keys k WHERE k.id = p_scope_id;
    IF v_target IS NULL OR v_target <> p_actor THEN
      RETURN jsonb_build_object('ok', false, 'code', 'not_found');
    END IF;
    IF v_env <> 'live' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'not_live');
    END IF;
  ELSE
    SELECT u.id INTO v_target FROM public.users u WHERE u.id = p_scope_id;
    IF v_target IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'not_found');
    END IF;
  END IF;

  SELECT c.daily_cap INTO v_old FROM public.api_v2_spend_caps c WHERE c.scope = p_scope AND c.scope_id = p_scope_id FOR NO KEY UPDATE;

  IF p_cap IS NULL THEN
    IF v_old IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'changed', false);
    END IF;
    DELETE FROM public.api_v2_spend_caps c WHERE c.scope = p_scope AND c.scope_id = p_scope_id;
    INSERT INTO public.admin_audit_log(admin_id, action, target_user_id, old_value, new_value)
    VALUES (p_actor, 'api_spend_cap_removed', v_target, jsonb_build_object('scope', p_scope, 'cap', v_old), jsonb_build_object('scope', p_scope, 'cap', NULL));
    RETURN jsonb_build_object('ok', true, 'changed', true);
  END IF;

  IF v_old IS NOT NULL AND v_old = round(p_cap, 2) THEN
    RETURN jsonb_build_object('ok', true, 'changed', false);
  END IF;
  INSERT INTO public.api_v2_spend_caps(scope, scope_id, daily_cap, set_by, updated_at)
  VALUES (p_scope, p_scope_id, round(p_cap, 2), p_actor, now())
  ON CONFLICT (scope, scope_id) DO UPDATE SET daily_cap = EXCLUDED.daily_cap, set_by = EXCLUDED.set_by, updated_at = now();
  INSERT INTO public.admin_audit_log(admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor, 'api_spend_cap_set', v_target, jsonb_build_object('scope', p_scope, 'cap', v_old), jsonb_build_object('scope', p_scope, 'cap', round(p_cap, 2)));
  RETURN jsonb_build_object('ok', true, 'changed', true);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_set_spend_cap(text, uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_set_spend_cap(text, uuid, numeric, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.api_v2_set_money_settings(p_caps boolean, p_alerts boolean, p_thresholds jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_old_caps boolean;
  v_old_alerts boolean;
  v_old_t jsonb;
  v_new_caps boolean;
  v_new_alerts boolean;
  v_new_t jsonb;
BEGIN
  IF p_actor IS NULL OR (p_thresholds IS NOT NULL AND jsonb_typeof(p_thresholds) <> 'object') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_input');
  END IF;
  -- Thresholds: only the known keys, each a positive number (a string or null would break or silence a risk signal).
  IF p_thresholds IS NOT NULL AND EXISTS (
       SELECT 1 FROM jsonb_each(p_thresholds) e
        WHERE e.key NOT IN ('spike_multiplier', 'spike_min_ghs', 'new_key_hours', 'new_key_min_ghs', 'fanout_recipients',
                            'fanout_minutes', 'cap_hits', 'cap_hits_minutes', 'failure_min_orders', 'failure_ratio', 'failure_minutes')
           OR jsonb_typeof(e.value) <> 'number' OR (e.value)::text::numeric <= 0) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_input');
  END IF;
  SELECT s.caps_enabled, s.alerts_enabled, s.thresholds INTO v_old_caps, v_old_alerts, v_old_t
    FROM public.api_v2_money_settings s WHERE s.id = 1 FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  v_new_caps := coalesce(p_caps, v_old_caps);
  v_new_alerts := coalesce(p_alerts, v_old_alerts);
  v_new_t := v_old_t || coalesce(p_thresholds, '{}'::jsonb);
  IF v_new_caps = v_old_caps AND v_new_alerts = v_old_alerts AND v_new_t = v_old_t THEN
    RETURN jsonb_build_object('ok', true, 'changed', false);
  END IF;
  UPDATE public.api_v2_money_settings s
     SET caps_enabled = v_new_caps, alerts_enabled = v_new_alerts, thresholds = v_new_t, updated_at = now(), updated_by = p_actor
   WHERE s.id = 1;
  INSERT INTO public.admin_audit_log(admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor, 'api_money_settings', NULL,
          jsonb_build_object('caps_enabled', v_old_caps, 'alerts_enabled', v_old_alerts, 'thresholds', v_old_t),
          jsonb_build_object('caps_enabled', v_new_caps, 'alerts_enabled', v_new_alerts, 'thresholds', v_new_t));
  RETURN jsonb_build_object('ok', true, 'changed', true);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_set_money_settings(boolean, boolean, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_set_money_settings(boolean, boolean, jsonb, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.api_v2_spend_today(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_day date := (now() AT TIME ZONE 'UTC')::date;
  v_start timestamptz := (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
  v_keys jsonb;
  v_user jsonb;
  v_refusals int;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key_id', k.id,
           'spent', coalesce((SELECT sum(l.amount) FROM public.api_v2_spend_ledger l
                               WHERE l.key_id = k.id AND l.day = v_day AND l.state IN ('reserved', 'spent')), 0),
           'cap', (SELECT c.daily_cap FROM public.api_v2_spend_caps c WHERE c.scope = 'key' AND c.scope_id = k.id))
           ORDER BY k.created_at, k.id), '[]'::jsonb)
    INTO v_keys
    FROM public.api_v2_keys k WHERE k.user_id = p_user AND k.environment = 'live';
  SELECT jsonb_build_object(
           'spent', coalesce((SELECT sum(l.amount) FROM public.api_v2_spend_ledger l
                               WHERE l.user_id = p_user AND l.day = v_day AND l.state IN ('reserved', 'spent')), 0),
           'cap', (SELECT c.daily_cap FROM public.api_v2_spend_caps c WHERE c.scope = 'user' AND c.scope_id = p_user))
    INTO v_user;
  SELECT count(*)::int INTO v_refusals FROM public.api_v2_logs g
   WHERE g.user_id = p_user AND g.error_reason = 'daily_limit' AND g.created_at >= v_start;
  RETURN jsonb_build_object('user', v_user, 'keys', v_keys, 'refusals_today', v_refusals);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_spend_today(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_spend_today(uuid) TO service_role;

-- Risk scan: live keys only; data orders are the spend source (commission amounts are not stored per order, and the ledger
-- only fills while caps are on). Numbers only in details; never phones or keys.
CREATE OR REPLACE FUNCTION public.api_v2_risk_scan(p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_on boolean;
  t jsonb;
  v_day_start timestamptz;
  v_hour timestamptz;
  v_out jsonb := '[]'::jsonb;
BEGIN
  SELECT s.alerts_enabled, s.thresholds INTO v_on, t FROM public.api_v2_money_settings s WHERE s.id = 1;
  IF NOT coalesce(v_on, false) THEN
    RETURN '[]'::jsonb;
  END IF;
  v_day_start := date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_hour := date_trunc('hour', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  -- spend_spike: today's data spend > multiplier x the trailing 7-day daily average, and > the floor.
  v_out := v_out || coalesce((
    SELECT jsonb_agg(jsonb_build_object('user_id', x.user_id, 'signal', 'spend_spike', 'bucket', v_day_start,
             'details', jsonb_build_object('today_ghs', x.today, 'daily_avg_7d_ghs', round(x.prior / 7.0, 2))))
      FROM (
        SELECT o.user_id,
               coalesce(sum(o.price) FILTER (WHERE o.created_at >= v_day_start), 0) AS today,
               coalesce(sum(o.price) FILTER (WHERE o.created_at < v_day_start), 0) AS prior
          FROM public.api_orders o
          JOIN public.api_v2_keys k ON k.id = o.api_v2_key_id AND k.environment = 'live'
         WHERE o.created_at >= v_day_start - interval '7 days' AND o.created_at <= v_now
           AND o.status NOT IN ('failed', 'refunded')
         GROUP BY o.user_id
      ) x
     WHERE x.today > (t->>'spike_min_ghs')::numeric
       AND x.today > (t->>'spike_multiplier')::numeric * (x.prior / 7.0)
  ), '[]'::jsonb);

  -- new_key_big_spend: a live key younger than new_key_hours has spent more than the floor.
  v_out := v_out || coalesce((
    SELECT jsonb_agg(jsonb_build_object('user_id', y.user_id, 'signal', 'new_key_big_spend', 'bucket', v_day_start,
             'details', jsonb_build_object('key_age_hours', y.age_h, 'spent_ghs', y.spent)))
      FROM (
        -- the threshold is applied per key BEFORE picking one key per person, so a newer unspent key cannot hide it
        SELECT DISTINCT ON (s.user_id) s.user_id, s.age_h, s.spent
          FROM (
            SELECT k.user_id,
                   round(extract(epoch FROM (v_now - k.created_at)) / 3600.0, 1) AS age_h,
                   (SELECT coalesce(sum(o.price), 0) FROM public.api_orders o
                     WHERE o.api_v2_key_id = k.id AND o.status NOT IN ('failed', 'refunded') AND o.created_at <= v_now) AS spent
              FROM public.api_v2_keys k
             WHERE k.environment = 'live' AND k.created_at > v_now - make_interval(hours => (t->>'new_key_hours')::int)
          ) s
         WHERE s.spent > (t->>'new_key_min_ghs')::numeric
         ORDER BY s.user_id, s.spent DESC
      ) y
  ), '[]'::jsonb);

  -- recipient_fanout: more distinct recipients than the limit within fanout_minutes.
  v_out := v_out || coalesce((
    SELECT jsonb_agg(jsonb_build_object('user_id', z.user_id, 'signal', 'recipient_fanout', 'bucket', v_hour,
             'details', jsonb_build_object('distinct_recipients', z.n, 'minutes', (t->>'fanout_minutes')::int)))
      FROM (
        SELECT o.user_id, count(DISTINCT o.recipient_phone) AS n
          FROM public.api_orders o
          JOIN public.api_v2_keys k ON k.id = o.api_v2_key_id AND k.environment = 'live'
         WHERE o.created_at > v_now - make_interval(mins => (t->>'fanout_minutes')::int) AND o.created_at <= v_now
         GROUP BY o.user_id
      ) z
     WHERE z.n > (t->>'fanout_recipients')::int
  ), '[]'::jsonb);

  -- cap_hits: at least cap_hits daily-limit refusals within cap_hits_minutes.
  v_out := v_out || coalesce((
    SELECT jsonb_agg(jsonb_build_object('user_id', h.user_id, 'signal', 'cap_hits', 'bucket', v_hour,
             'details', jsonb_build_object('refusals', h.n, 'minutes', (t->>'cap_hits_minutes')::int)))
      FROM (
        SELECT g.user_id, count(*) AS n
          FROM public.api_v2_logs g
         WHERE g.error_reason = 'daily_limit' AND g.environment = 'live' AND g.user_id IS NOT NULL
           AND g.created_at > v_now - make_interval(mins => (t->>'cap_hits_minutes')::int) AND g.created_at <= v_now
         GROUP BY g.user_id
      ) h
     WHERE h.n >= (t->>'cap_hits')::int
  ), '[]'::jsonb);

  -- failure_burst: at least failure_min_orders purchases in failure_minutes, with more than failure_ratio failed.
  v_out := v_out || coalesce((
    SELECT jsonb_agg(jsonb_build_object('user_id', f.user_id, 'signal', 'failure_burst', 'bucket', v_hour,
             'details', jsonb_build_object('orders', f.total, 'failed', f.failed, 'minutes', (t->>'failure_minutes')::int)))
      FROM (
        SELECT o.user_id, count(*) AS total, count(*) FILTER (WHERE o.status IN ('failed', 'refunded')) AS failed
          FROM public.api_orders o
          JOIN public.api_v2_keys k ON k.id = o.api_v2_key_id AND k.environment = 'live'
         WHERE o.created_at > v_now - make_interval(mins => (t->>'failure_minutes')::int) AND o.created_at <= v_now
         GROUP BY o.user_id
      ) f
     WHERE f.total >= (t->>'failure_min_orders')::int
       AND f.failed::numeric / f.total > (t->>'failure_ratio')::numeric
  ), '[]'::jsonb);

  RETURN v_out;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_risk_scan(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_risk_scan(timestamptz) TO service_role;

-- ============ 2. new tables (no foreign keys, so no lock on any existing table) ============

CREATE TABLE IF NOT EXISTS public.api_v2_money_settings (
  id int PRIMARY KEY CHECK (id = 1),
  caps_enabled boolean NOT NULL DEFAULT false,
  alerts_enabled boolean NOT NULL DEFAULT false,
  thresholds jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.api_v2_spend_caps (
  scope text NOT NULL CHECK (scope IN ('key', 'user')),
  scope_id uuid NOT NULL,
  daily_cap numeric(12,2) NOT NULL CHECK (daily_cap > 0 AND daily_cap <= 1000000),
  set_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE IF NOT EXISTS public.api_v2_spend_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  key_id uuid NOT NULL,
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('data', 'data_bulk', 'airtime', 'bill', 'bundle', 'results', 'afa')),
  reference text NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 200),
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  state text NOT NULL CHECK (state IN ('reserved', 'spent', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_v2_spend_ledger_once UNIQUE (key_id, kind, reference)
);
CREATE INDEX IF NOT EXISTS api_v2_spend_ledger_user_day_idx ON public.api_v2_spend_ledger (user_id, day);
CREATE INDEX IF NOT EXISTS api_v2_spend_ledger_key_day_idx ON public.api_v2_spend_ledger (key_id, day);

CREATE TABLE IF NOT EXISTS public.api_v2_risk_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  signal text NOT NULL CHECK (signal IN ('spend_spike', 'new_key_big_spend', 'recipient_fanout', 'cap_hits', 'failure_burst')),
  bucket timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_v2_risk_alerts_once UNIQUE (user_id, signal, bucket)
);
CREATE INDEX IF NOT EXISTS api_v2_risk_alerts_user_idx ON public.api_v2_risk_alerts (user_id, created_at DESC);

-- seed: both switches off, the spec section 7 thresholds (operational defaults, not prices); an existing row is never touched
INSERT INTO public.api_v2_money_settings(id, caps_enabled, alerts_enabled, thresholds)
VALUES (1, false, false, jsonb_build_object(
  'spike_multiplier', 3, 'spike_min_ghs', 200, 'new_key_hours', 24, 'new_key_min_ghs', 100,
  'fanout_recipients', 30, 'fanout_minutes', 10, 'cap_hits', 3, 'cap_hits_minutes', 60,
  'failure_min_orders', 20, 'failure_ratio', 0.5, 'failure_minutes', 15))
ON CONFLICT (id) DO NOTHING;

-- ============ 3. access: service role only (RLS on, no policies) ============

ALTER TABLE public.api_v2_money_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_spend_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_spend_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_risk_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_v2_money_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.api_v2_spend_caps FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.api_v2_spend_ledger FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.api_v2_risk_alerts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.api_v2_money_settings TO service_role;
GRANT ALL ON TABLE public.api_v2_spend_caps TO service_role;
GRANT ALL ON TABLE public.api_v2_spend_ledger TO service_role;
GRANT ALL ON TABLE public.api_v2_risk_alerts TO service_role;

COMMIT;
