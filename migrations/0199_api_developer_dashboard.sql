-- 0199_api_developer_dashboard.sql
--
-- API v2 Release 3 (developer dashboard): read functions for the developer's own usage, request logs and orders, the
-- low-balance alert table, and request-log retention. Spec: docs/superpowers/specs/2026-11-25-api-dashboard-r3-design.md.
--
-- ADDITIVE: one new service-role-only table and seven SECURITY DEFINER functions. Nothing is sent and nothing is deleted
-- by applying this (the alert table starts empty; retention runs only when its cron calls it). No existing table is altered,
-- no index is added to a busy table, and no foreign key is created. One transaction. Idempotent.
--
-- Table
--   api_v2_balance_alerts   user_id pk -> threshold GHS (> 0, <= 100000), enabled, armed (one send per crossing), last_sent_at.
--
-- Functions (service_role EXECUTE only; search_path pinned to public, pg_temp). p_user always comes from a verified session.
--   api_v2_dev_usage(user, days, env)                  per-day ok/failed, endpoints, failure reasons, orders per product.
--   api_v2_dev_logs(user, filters, before_at, before_id, limit)     own log rows, newest first, keyset (created_at, id).
--   api_v2_dev_orders(user, filters, before_at, before_key, limit)  own live orders: data (api_orders) + commission claims.
--   api_v2_set_balance_alert(user, threshold)          upsert (re-armed) or delete when threshold is null.
--   api_v2_get_balance_alert(user)                     the setting and the wallet balance.
--   api_v2_balance_alert_scan(now)                     re-arms recovered rows, disarms and returns rows to notify.
--   api_v2_logs_retention(now)                         deletes api_v2_logs rows older than 25 months, max 5000 per call.
--
-- LOCKS: only the new objects. lock_timeout 2s bounds only the wait; a lock timeout (SQLSTATE 55P03) is harmless and safe
-- to retry. Any quiet window is fine.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.api_v2_balance_alerts');                                                   -- NULL
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
--      AND p.proname IN ('api_v2_dev_usage','api_v2_dev_logs','api_v2_dev_orders','api_v2_set_balance_alert',
--      'api_v2_get_balance_alert','api_v2_balance_alert_scan','api_v2_logs_retention');                    -- 0
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_v2_logs'
--      AND column_name IN ('error_reason','key_id','status_code','environment','endpoint','created_at');   -- 6 rows
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_v2_idempotency'
--      AND column_name IN ('user_id','kind','reference','status','response','created_at');                 -- 6 rows
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'wallets'
--      AND column_name IN ('user_id','balance');                                                           -- 2 rows
--   SELECT table_name, count(*) FROM information_schema.columns WHERE table_schema = 'public'
--      AND table_name IN ('airtime_orders','hubtel_bill_orders','hubtel_data_orders','results_checker_orders','afa_orders')
--      AND column_name IN ('user_id','status','reference_code','order_code') GROUP BY table_name;          -- 3 each (afa: order_code)
--
-- VERIFY after applying:
--   SELECT has_table_privilege('anon','public.api_v2_balance_alerts','SELECT'),
--          has_function_privilege('authenticated','public.api_v2_dev_logs(uuid,jsonb,timestamptz,uuid,integer)','EXECUTE'),
--          has_function_privilege('service_role','public.api_v2_dev_logs(uuid,jsonb,timestamptz,uuid,integer)','EXECUTE');  -- false, false, true
--   SELECT count(*) FROM pg_policies WHERE tablename = 'api_v2_balance_alerts';                             -- 0
--   SELECT count(*) FROM public.api_v2_balance_alerts;                                                     -- 0
--
-- Dry run: migrations/0199_api_developer_dashboard.selftest.sql through lib/api-v2/migration-0199-run.ts (never by hand).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

-- ============ 1. table ============

CREATE TABLE IF NOT EXISTS public.api_v2_balance_alerts (
  user_id uuid PRIMARY KEY,
  threshold numeric(12,2) NOT NULL CONSTRAINT api_v2_balance_alerts_threshold_check CHECK (threshold > 0 AND threshold <= 100000),
  enabled boolean NOT NULL DEFAULT true,
  armed boolean NOT NULL DEFAULT true,
  last_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.api_v2_balance_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_v2_balance_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_v2_balance_alerts TO service_role;

-- ============ 2. functions ============

-- Usage for the last 7 or 30 days (UTC days = Ghana time). Logs are read through the person's key ids so the existing
-- (key_id, created_at) index serves the query. failed = status >= 400. p_env: 'live' | 'test' | NULL (both).
CREATE OR REPLACE FUNCTION public.api_v2_dev_usage(p_user uuid, p_days integer, p_env text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '10s'
AS $fn$
DECLARE
  v_days int := CASE WHEN p_days = 30 THEN 30 ELSE 7 END;
  v_env text := CASE WHEN p_env IN ('live', 'test') THEN p_env END;
  v_since timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => v_days - 1);
  v_keys uuid[];
  v_daily jsonb;
  v_endpoints jsonb;
  v_reasons jsonb;
  v_orders jsonb;
BEGIN
  IF p_user IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(array_agg(k.id), '{}') INTO v_keys FROM public.api_v2_keys k WHERE k.user_id = p_user;

  SELECT coalesce(jsonb_agg(jsonb_build_object('day', to_char(d.day AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'ok', coalesce(c.ok, 0), 'failed', coalesce(c.failed, 0))
                            ORDER BY d.day), '[]'::jsonb)
    INTO v_daily
    FROM generate_series(v_since, v_since + make_interval(days => v_days - 1), interval '1 day') AS d(day)
    LEFT JOIN (
      SELECT date_trunc('day', l.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day,
             count(*) FILTER (WHERE l.status_code < 400) AS ok,
             count(*) FILTER (WHERE l.status_code >= 400) AS failed
        FROM public.api_v2_logs l
       WHERE l.key_id = ANY (v_keys) AND l.created_at >= v_since AND (v_env IS NULL OR l.environment = v_env)
       GROUP BY 1
    ) c ON c.day = d.day;

  SELECT coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'total', s.total, 'failed', s.failed) ORDER BY s.total DESC, s.endpoint), '[]'::jsonb)
    INTO v_endpoints
    FROM (
      SELECT l.endpoint, count(*) AS total, count(*) FILTER (WHERE l.status_code >= 400) AS failed
        FROM public.api_v2_logs l
       WHERE l.key_id = ANY (v_keys) AND l.created_at >= v_since AND (v_env IS NULL OR l.environment = v_env) AND l.endpoint IS NOT NULL
       GROUP BY l.endpoint
       ORDER BY count(*) DESC, l.endpoint
       LIMIT 50
    ) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object('reason', s.reason, 'count', s.n) ORDER BY s.n DESC, s.reason), '[]'::jsonb)
    INTO v_reasons
    FROM (
      SELECT l.error_reason AS reason, count(*) AS n
        FROM public.api_v2_logs l
       WHERE l.key_id = ANY (v_keys) AND l.created_at >= v_since AND (v_env IS NULL OR l.environment = v_env)
         AND l.error_reason IS NOT NULL AND l.status_code >= 400
       GROUP BY l.error_reason
       ORDER BY count(*) DESC, l.error_reason
       LIMIT 10
    ) s;

  -- Orders are live only (test purchases live in the sandbox tables). Commission claims: kinds other than sms.
  SELECT coalesce(jsonb_object_agg(s.product, s.n), '{}'::jsonb)
    INTO v_orders
    FROM (
      SELECT 'data' AS product, count(*) AS n
        FROM public.api_orders o
       WHERE o.user_id = p_user AND o.api_v2_key_id IS NOT NULL AND o.created_at >= v_since AND coalesce(v_env, 'live') = 'live'
      UNION ALL
      SELECT i.kind, count(*)
        FROM public.api_v2_idempotency i
       WHERE i.user_id = p_user AND i.kind = ANY ('{airtime,bill,bundle,results,afa}'::text[]) AND i.created_at >= v_since
         AND coalesce(v_env, 'live') = 'live'
       GROUP BY i.kind
    ) s
   WHERE s.n > 0;

  RETURN jsonb_build_object('days', v_days, 'since', v_since, 'daily', v_daily, 'endpoints', v_endpoints,
                            'reasons', v_reasons, 'orders', v_orders);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_dev_usage(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_dev_usage(uuid, integer, text) TO service_role;

-- The person's own log rows, newest first. Filters (all optional): key (uuid, must be theirs), env, status
-- ('ok' < 400, 'client' 400-499, 'server' >= 500), endpoint (exact), from, to. The window is at most 31 days, ending at
-- `to` (default now). Keyset paging on (created_at, id). Limit 1..100 (default 50).
CREATE OR REPLACE FUNCTION public.api_v2_dev_logs(p_user uuid, p_filters jsonb, p_before_at timestamptz, p_before_id uuid, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '10s'
AS $fn$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_uuid_re text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_key uuid;
  v_env text := CASE WHEN f->>'env' IN ('live', 'test') THEN f->>'env' END;
  v_status text := CASE WHEN f->>'status' IN ('ok', 'client', 'server') THEN f->>'status' END;
  v_endpoint text := nullif(left(f->>'endpoint', 200), '');
  v_to timestamptz;
  v_from timestamptz;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_keys uuid[];
  v_rows jsonb;
BEGIN
  IF p_user IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  IF f ? 'key' AND f->>'key' IS NOT NULL THEN
    IF NOT (f->>'key') ~ v_uuid_re THEN
      RETURN '[]'::jsonb;
    END IF;
    v_key := (f->>'key')::uuid;
  END IF;
  BEGIN
    v_to := least(coalesce((f->>'to')::timestamptz, now()), now());
    v_from := (f->>'from')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN '[]'::jsonb;
  END;
  v_from := greatest(coalesce(v_from, v_to - interval '31 days'), v_to - interval '31 days');
  IF (p_before_at IS NULL) <> (p_before_id IS NULL) THEN
    RETURN '[]'::jsonb;   -- a cursor is both parts or none
  END IF;

  SELECT coalesce(array_agg(k.id), '{}') INTO v_keys
    FROM public.api_v2_keys k WHERE k.user_id = p_user AND (v_key IS NULL OR k.id = v_key);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'created_at', s.created_at, 'method', s.method, 'endpoint', s.endpoint, 'status', s.status_code,
           'reason', s.error_reason, 'duration_ms', s.duration_ms, 'environment', s.environment, 'ip', s.ip_address, 'key_id', s.key_id)
           ORDER BY s.created_at DESC, s.id DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT l.id, l.created_at, l.method, l.endpoint, l.status_code, l.error_reason, l.duration_ms, l.environment, l.ip_address, l.key_id
        FROM public.api_v2_logs l
       WHERE l.key_id = ANY (v_keys)
         AND l.created_at >= v_from AND l.created_at <= v_to
         AND (v_env IS NULL OR l.environment = v_env)
         AND (v_endpoint IS NULL OR l.endpoint = v_endpoint)
         AND (v_status IS NULL
              OR (v_status = 'ok' AND l.status_code < 400)
              OR (v_status = 'client' AND l.status_code >= 400 AND l.status_code < 500)
              OR (v_status = 'server' AND l.status_code >= 500))
         AND (p_before_at IS NULL OR (l.created_at, l.id) < (p_before_at, p_before_id))
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT v_limit
    ) s;
  RETURN v_rows;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_dev_logs(uuid, jsonb, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_dev_logs(uuid, jsonb, timestamptz, uuid, integer) TO service_role;

-- The person's own LIVE orders: data from api_orders (v2 keys), commission from api_v2_idempotency (not sms). The public
-- status mirrors lib/api-v2/data-orders.ts mapOrderStatus and lib/api-v2/commission.ts mapCommissionStatus (tested).
-- Filters (all optional): reference (exact; searches every date), recipient (exact local 0XXXXXXXXX or account), product
-- (data|airtime|bill|bundle|results|afa), status (public status), from, to (window at most 31 days, ending at `to`).
-- Keyset on (created_at, sort_key) where sort_key = product || ':' || reference. Limit 1..5000 (default 50).
CREATE OR REPLACE FUNCTION public.api_v2_dev_orders(p_user uuid, p_filters jsonb, p_before_at timestamptz, p_before_key text, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '15s'
AS $fn$
DECLARE
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_ref text := nullif(left(f->>'reference', 100), '');
  v_recipient text := nullif(left(f->>'recipient', 64), '');
  v_product text := CASE WHEN f->>'product' IN ('data', 'airtime', 'bill', 'bundle', 'results', 'afa') THEN f->>'product' END;
  v_status text := nullif(left(f->>'status', 20), '');
  v_to timestamptz;
  v_from timestamptz;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 5000);
  v_rows jsonb;
BEGIN
  IF p_user IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  BEGIN
    v_to := least(coalesce((f->>'to')::timestamptz, now()), now());
    v_from := (f->>'from')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN '[]'::jsonb;
  END;
  IF v_ref IS NOT NULL THEN
    v_from := '-infinity'::timestamptz;   -- a reference search covers every date
    v_to := 'infinity'::timestamptz;
  ELSE
    v_from := greatest(coalesce(v_from, v_to - interval '31 days'), v_to - interval '31 days');
  END IF;
  IF (p_before_at IS NULL) <> (p_before_key IS NULL) THEN
    RETURN '[]'::jsonb;   -- a cursor is both parts or none
  END IF;

  WITH u AS (
    SELECT 'data'::text AS product, o.api_reference AS reference, o.created_at,
           o.recipient_phone AS recipient,
           round(o.price::numeric, 2) AS amount,
           concat_ws(' ', o.network, CASE WHEN o.volume_gb IS NOT NULL THEN trim_scale(round(o.volume_gb::numeric, 2))::text || ' GB' END) AS item,
           CASE lower(trim(coalesce(o.status, '')))
             WHEN 'pending' THEN 'pending' WHEN 'processing' THEN 'processing' WHEN 'completed' THEN 'completed'
             WHEN 'failed' THEN 'failed' WHEN 'refunded' THEN 'refunded' WHEN 'cancelled' THEN 'failed'
             WHEN 'held_registration' THEN 'queued' ELSE 'processing' END AS status
      FROM public.api_orders o
     WHERE o.user_id = p_user AND o.api_v2_key_id IS NOT NULL
       AND (v_product IS NULL OR v_product = 'data')
       AND (v_ref IS NULL OR o.api_reference = v_ref)
       AND o.created_at >= v_from AND o.created_at <= v_to
    UNION ALL
    SELECT i.kind, i.reference, i.created_at,
           coalesce(i.response->>'recipient', i.response->>'account', i.response->>'phone'),
           round(CASE WHEN jsonb_typeof(i.response->'total_paid') = 'number' THEN (i.response->>'total_paid')::numeric
                      WHEN jsonb_typeof(i.response->'paid_amount') = 'number' THEN (i.response->>'paid_amount')::numeric
                      WHEN jsonb_typeof(i.response->'amount') = 'number' THEN (i.response->>'amount')::numeric END, 2),
           CASE i.kind
             WHEN 'bill' THEN i.response->>'biller'
             WHEN 'bundle' THEN concat_ws(' ', i.response->>'network', i.response->>'bundle')
             WHEN 'results' THEN i.response->>'exam_board'
             WHEN 'afa' THEN 'AFA registration'
             ELSE i.response->>'network' END,
           CASE i.status
             WHEN 'in_progress' THEN 'processing'
             WHEN 'unknown' THEN 'unknown'
             -- done: the LIVE product row (owner-scoped, as the public GET endpoints read it), else the stored order.
             ELSE CASE lower(trim(coalesce(
                    CASE WHEN i.order_ref IS NOT NULL THEN
                      CASE i.kind
                        WHEN 'airtime' THEN (SELECT x.status::text FROM public.airtime_orders x WHERE x.user_id = p_user AND x.reference_code = i.order_ref LIMIT 1)
                        WHEN 'bill' THEN (SELECT x.status::text FROM public.hubtel_bill_orders x WHERE x.user_id = p_user AND x.reference_code = i.order_ref LIMIT 1)
                        WHEN 'bundle' THEN (SELECT x.status::text FROM public.hubtel_data_orders x WHERE x.user_id = p_user AND x.reference_code = i.order_ref LIMIT 1)
                        WHEN 'results' THEN (SELECT x.status::text FROM public.results_checker_orders x WHERE x.user_id = p_user AND x.reference_code = i.order_ref LIMIT 1)
                        WHEN 'afa' THEN (SELECT x.status::text FROM public.afa_orders x WHERE x.user_id = p_user AND x.order_code = i.order_ref LIMIT 1)
                      END
                    END,
                    i.response->>'status', '')))
                    WHEN 'pending' THEN 'pending' WHEN 'pending_payment' THEN 'pending' WHEN 'processing' THEN 'processing'
                    WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'refunded' THEN 'refunded'
                    ELSE 'processing' END END
      FROM public.api_v2_idempotency i
     WHERE i.user_id = p_user AND i.kind = ANY ('{airtime,bill,bundle,results,afa}'::text[])
       AND (v_product IS NULL OR v_product = i.kind)
       AND (v_ref IS NULL OR i.reference = v_ref)
       AND i.created_at >= v_from AND i.created_at <= v_to
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('product', s.product, 'reference', s.reference, 'created_at', s.created_at,
           'recipient', s.recipient, 'amount', s.amount, 'item', s.item, 'status', s.status)
           ORDER BY s.created_at DESC, s.product || ':' || s.reference DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT u.* FROM u
       WHERE (v_recipient IS NULL OR u.recipient = v_recipient)
         AND (v_status IS NULL OR u.status = v_status)
         AND (p_before_at IS NULL OR (u.created_at, u.product || ':' || u.reference) < (p_before_at, p_before_key))
       ORDER BY u.created_at DESC, u.product || ':' || u.reference DESC
       LIMIT v_limit
    ) s;
  RETURN v_rows;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_dev_orders(uuid, jsonb, timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_dev_orders(uuid, jsonb, timestamptz, text, integer) TO service_role;

-- Set (upsert, re-armed) or remove (NULL) the person's low-balance threshold. Returns the stored setting or {removed:true}.
CREATE OR REPLACE FUNCTION public.api_v2_set_balance_alert(p_user uuid, p_threshold numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.api_v2_balance_alerts;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'user required';
  END IF;
  IF p_threshold IS NULL THEN
    DELETE FROM public.api_v2_balance_alerts WHERE user_id = p_user;
    RETURN jsonb_build_object('removed', true);
  END IF;
  IF p_threshold <= 0 OR p_threshold > 100000 OR p_threshold <> round(p_threshold, 2) THEN
    RAISE EXCEPTION 'threshold out of range' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.api_v2_balance_alerts AS a (user_id, threshold, enabled, armed, updated_at)
  VALUES (p_user, p_threshold, true, true, now())
  ON CONFLICT (user_id) DO UPDATE SET threshold = EXCLUDED.threshold, enabled = true, armed = true, updated_at = now()
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('threshold', v_row.threshold, 'enabled', v_row.enabled, 'armed', v_row.armed, 'last_sent_at', v_row.last_sent_at);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_set_balance_alert(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_set_balance_alert(uuid, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.api_v2_get_balance_alert(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_alert jsonb;
  v_balance numeric;
BEGIN
  IF p_user IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT jsonb_build_object('threshold', a.threshold, 'enabled', a.enabled, 'armed', a.armed, 'last_sent_at', a.last_sent_at)
    INTO v_alert FROM public.api_v2_balance_alerts a WHERE a.user_id = p_user;
  SELECT w.balance INTO v_balance FROM public.wallets w WHERE w.user_id = p_user;
  RETURN jsonb_build_object('alert', v_alert, 'balance', round(v_balance, 2));
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_get_balance_alert(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_get_balance_alert(uuid) TO service_role;

-- One pass of the low-balance alert: re-arm rows whose balance is back at or above the threshold, then disarm and return
-- the armed rows now below it. The disarming UPDATE re-checks `armed` under the row lock, so two overlapping cron runs can
-- never return the same row (one send per crossing). Returns [{user_id, threshold, balance}].
CREATE OR REPLACE FUNCTION public.api_v2_balance_alert_scan(p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '15s'
AS $fn$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_out jsonb;
BEGIN
  -- Lock the enabled rows in one fixed order first, so two overlapping runs queue instead of deadlocking.
  PERFORM 1 FROM public.api_v2_balance_alerts a WHERE a.enabled ORDER BY a.user_id FOR UPDATE;

  UPDATE public.api_v2_balance_alerts a SET armed = true, updated_at = v_now
    FROM public.wallets w
   WHERE w.user_id = a.user_id AND a.enabled AND NOT a.armed AND w.balance >= a.threshold;

  WITH fired AS (
    UPDATE public.api_v2_balance_alerts a SET armed = false, last_sent_at = v_now, updated_at = v_now
      FROM public.wallets w
     WHERE w.user_id = a.user_id AND a.enabled AND a.armed AND w.balance < a.threshold
    RETURNING a.user_id, a.threshold, round(w.balance, 2) AS balance
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', f.user_id, 'threshold', f.threshold, 'balance', f.balance)), '[]'::jsonb)
    INTO v_out FROM fired f;
  RETURN v_out;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_balance_alert_scan(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_balance_alert_scan(timestamptz) TO service_role;

-- Request-log retention: rows older than 25 months. The admin report caps a range at 24 months, so a range ending within
-- the last month stays whole; an older range undercounts request numbers only (orders and money come from order tables).
-- At most 5000 rows per call (well inside the caller's ~8 s PostgREST timeout); the created_at index finds them.
CREATE OR REPLACE FUNCTION public.api_v2_logs_retention(p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_cut timestamptz := coalesce(p_now, now()) - interval '25 months';
  v_n int;
BEGIN
  DELETE FROM public.api_v2_logs l
   WHERE l.id IN (SELECT x.id FROM public.api_v2_logs x WHERE x.created_at < v_cut ORDER BY x.created_at LIMIT 5000);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_logs_retention(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_logs_retention(timestamptz) TO service_role;

COMMIT;
