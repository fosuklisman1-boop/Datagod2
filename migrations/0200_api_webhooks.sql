-- 0200_api_webhooks.sql
--
-- API v2 Release 6 (webhooks): one endpoint per developer, an event queue fed by a once-a-minute scan of live v2 orders,
-- leased delivery with a retry schedule, a delivery log, and a global switch. Spec:
-- docs/superpowers/specs/2026-11-26-api-webhooks-r6-design.md.
--
-- ADDITIVE: five new service-role-only tables and sixteen SECURITY DEFINER functions. Nothing is sent by applying this:
-- the switch row starts enabled = false, the endpoint table starts empty, and the scan/claim functions do nothing while
-- the switch is off. No existing table is altered, no index is added to an existing table, no foreign key is created,
-- and no trigger is added (the scan reads the order tables; it never writes them). One transaction. Idempotent.
--
-- Tables
--   api_v2_webhook_settings    id = 1 singleton: enabled (false), updated_at, updated_by.
--   api_v2_webhook_endpoints   user_id pk -> https url, whsec_ secret, enabled, created_at (scan baseline), updated_at.
--   api_v2_webhook_state       (user_id, product, reference) -> last final status notified.
--   api_v2_webhook_events      evt_ id, owner, type, payload, state, attempts / max_attempts, next_attempt_at (lease), last result.
--   api_v2_webhook_attempts    one row per delivery attempt (code, duration, short error, response snippet).
--
-- Functions (service_role EXECUTE only; search_path pinned to public, pg_temp). p_user always comes from a verified session.
--   api_v2_webhook_orders(user, since)                      the person's live v2 orders with the 0199 status mapping.
--   api_v2_webhook_get / set_endpoint / rotate_secret / reveal / delete_endpoint   endpoint management.
--   api_v2_webhook_scan(now, limit)                         queue order.updated for final-status changes (advisory-locked).
--   api_v2_webhook_claim(now, limit) / claim_one(user, id, now)   lease due events (3 min), max 10 per person per claim.
--   api_v2_webhook_record(id, attempt, ok, code, ms, error, snippet, now)  log an attempt; schedule, deliver or fail.
--   api_v2_webhook_enqueue_test / resend / deliveries       developer tools.
--   api_v2_webhook_settings_get / settings_set              admin switch and today's counts.
--   api_v2_webhook_retention(now)                           events + attempts > 30 days, state > 8 days, 5000 per call.
--
-- LOCKS: only the new objects. lock_timeout 2s bounds only the wait; a lock timeout (SQLSTATE 55P03) is harmless and safe
-- to retry. Any quiet window is fine.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.api_v2_webhook_settings'), to_regclass('public.api_v2_webhook_endpoints'),
--          to_regclass('public.api_v2_webhook_state'), to_regclass('public.api_v2_webhook_events'),
--          to_regclass('public.api_v2_webhook_attempts');                                                    -- all NULL
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname LIKE 'api\_v2\_webhook\_%';                                     -- 0
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_orders'
--      AND column_name IN ('user_id','api_v2_key_id','api_reference','status','created_at','recipient_phone','price','network','volume_gb');  -- 9 rows
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_v2_idempotency'
--      AND column_name IN ('user_id','kind','reference','status','order_ref','response','created_at');      -- 7 rows
--   SELECT table_name, count(*) FROM information_schema.columns WHERE table_schema = 'public'
--      AND table_name IN ('airtime_orders','hubtel_bill_orders','hubtel_data_orders','results_checker_orders','afa_orders')
--      AND column_name IN ('user_id','status','reference_code','order_code') GROUP BY table_name;           -- 3 each (afa: order_code)
--   SELECT proname FROM pg_proc WHERE proname IN ('gen_random_uuid','trim_scale','pg_try_advisory_xact_lock'); -- 3 rows
--
-- VERIFY after applying:
--   SELECT has_table_privilege('anon','public.api_v2_webhook_endpoints','SELECT'),
--          has_function_privilege('authenticated','public.api_v2_webhook_reveal(uuid)','EXECUTE'),
--          has_function_privilege('service_role','public.api_v2_webhook_claim(timestamptz,integer)','EXECUTE');  -- false, false, true
--   SELECT count(*) FROM pg_policies WHERE tablename LIKE 'api_v2_webhook_%';                                  -- 0
--   SELECT enabled FROM public.api_v2_webhook_settings;                                                       -- false
--   SELECT count(*) FROM public.api_v2_webhook_endpoints;                                                     -- 0
--
-- Dry run: migrations/0200_api_webhooks.selftest.sql through lib/api-v2/migration-0200-run.ts (never by hand).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

-- ============ 1. tables ============

CREATE TABLE IF NOT EXISTS public.api_v2_webhook_settings (
  id integer PRIMARY KEY CONSTRAINT api_v2_webhook_settings_singleton CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
INSERT INTO public.api_v2_webhook_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.api_v2_webhook_endpoints (
  user_id uuid PRIMARY KEY,
  url text NOT NULL CONSTRAINT api_v2_webhook_endpoints_url_check CHECK (char_length(url) BETWEEN 12 AND 500 AND url LIKE 'https://%'),
  secret text NOT NULL CONSTRAINT api_v2_webhook_endpoints_secret_check CHECK (secret ~ '^whsec_[A-Za-z0-9_-]{43}$'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.api_v2_webhook_state (
  user_id uuid NOT NULL,
  product text NOT NULL,
  reference text NOT NULL,
  last_status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product, reference)
);
CREATE INDEX IF NOT EXISTS api_v2_webhook_state_updated_idx ON public.api_v2_webhook_state (updated_at);

CREATE TABLE IF NOT EXISTS public.api_v2_webhook_events (
  id text PRIMARY KEY CONSTRAINT api_v2_webhook_events_id_check CHECK (id ~ '^evt_[0-9a-f]{24}$'),
  user_id uuid NOT NULL,
  type text NOT NULL CONSTRAINT api_v2_webhook_events_type_check CHECK (type IN ('order.updated', 'webhook.test')),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CONSTRAINT api_v2_webhook_events_state_check CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 7 CONSTRAINT api_v2_webhook_events_max_check CHECK (max_attempts BETWEEN 1 AND 7),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_code integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_v2_webhook_events_due_idx ON public.api_v2_webhook_events (next_attempt_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS api_v2_webhook_events_user_idx ON public.api_v2_webhook_events (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS api_v2_webhook_events_created_idx ON public.api_v2_webhook_events (created_at);

CREATE TABLE IF NOT EXISTS public.api_v2_webhook_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL,
  attempt integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  code integer,
  duration_ms integer,
  error text,
  response_snippet text
);
CREATE INDEX IF NOT EXISTS api_v2_webhook_attempts_event_idx ON public.api_v2_webhook_attempts (event_id, at DESC);

ALTER TABLE public.api_v2_webhook_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_webhook_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_webhook_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_v2_webhook_settings, public.api_v2_webhook_endpoints, public.api_v2_webhook_state,
  public.api_v2_webhook_events, public.api_v2_webhook_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.api_v2_webhook_settings, public.api_v2_webhook_endpoints, public.api_v2_webhook_state,
  public.api_v2_webhook_events, public.api_v2_webhook_attempts TO service_role;

-- ============ 2. the person's live v2 orders (same mapping as api_v2_dev_orders in 0199) ============

CREATE OR REPLACE FUNCTION public.api_v2_webhook_orders(p_user uuid, p_since timestamptz)
RETURNS TABLE (product text, reference text, created_at timestamptz, recipient text, amount numeric, item text, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT 'data'::text, o.api_reference, o.created_at, o.recipient_phone, round(o.price::numeric, 2),
         concat_ws(' ', o.network, CASE WHEN o.volume_gb IS NOT NULL THEN trim_scale(round(o.volume_gb::numeric, 2))::text || ' GB' END),
         CASE lower(trim(coalesce(o.status, '')))
           WHEN 'pending' THEN 'pending' WHEN 'processing' THEN 'processing' WHEN 'completed' THEN 'completed'
           WHEN 'failed' THEN 'failed' WHEN 'refunded' THEN 'refunded' WHEN 'cancelled' THEN 'failed'
           WHEN 'held_registration' THEN 'queued' ELSE 'processing' END
    FROM public.api_orders o
   WHERE o.user_id = p_user AND o.api_v2_key_id IS NOT NULL AND o.api_reference IS NOT NULL AND o.created_at >= p_since
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
   WHERE i.user_id = p_user AND i.kind = ANY ('{airtime,bill,bundle,results,afa}'::text[]) AND i.created_at >= p_since
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_orders(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_orders(uuid, timestamptz) TO service_role;

-- ============ 3. endpoint management ============

-- The endpoint without its secret (only a four-character hint), plus whether webhooks are switched on.
CREATE OR REPLACE FUNCTION public.api_v2_webhook_get(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  w public.api_v2_webhook_endpoints;
BEGIN
  SELECT * INTO w FROM public.api_v2_webhook_endpoints e WHERE e.user_id = p_user;
  RETURN jsonb_build_object(
    'enabled_globally', coalesce((SELECT s.enabled FROM public.api_v2_webhook_settings s WHERE s.id = 1), false),
    'endpoint', CASE WHEN w.user_id IS NULL THEN NULL ELSE jsonb_build_object('url', w.url, 'enabled', w.enabled,
      'created_at', w.created_at, 'updated_at', w.updated_at, 'secret_hint', right(w.secret, 4)) END);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_get(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_get(uuid) TO service_role;

-- Create (needs p_new_secret) or edit url/enabled (the secret and created_at, the scan baseline, are kept).
CREATE OR REPLACE FUNCTION public.api_v2_webhook_set_endpoint(p_user uuid, p_url text, p_enabled boolean, p_new_secret text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_exists boolean;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'user required';
  END IF;
  IF p_url IS NULL OR char_length(p_url) NOT BETWEEN 12 AND 500 OR p_url NOT LIKE 'https://%' THEN
    RAISE EXCEPTION 'url must be https and at most 500 characters' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.api_v2_webhook_endpoints e WHERE e.user_id = p_user FOR UPDATE;
  v_exists := FOUND;
  IF v_exists THEN
    UPDATE public.api_v2_webhook_endpoints e SET url = p_url, enabled = coalesce(p_enabled, e.enabled), updated_at = now()
     WHERE e.user_id = p_user;
  ELSE
    IF p_new_secret IS NULL THEN
      RAISE EXCEPTION 'secret required for a new endpoint' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.api_v2_webhook_endpoints (user_id, url, secret, enabled) VALUES (p_user, p_url, p_new_secret, coalesce(p_enabled, true));
  END IF;
  RETURN public.api_v2_webhook_get(p_user) || jsonb_build_object('created', NOT v_exists);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_set_endpoint(uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_set_endpoint(uuid, text, boolean, text) TO service_role;

CREATE OR REPLACE FUNCTION public.api_v2_webhook_rotate_secret(p_user uuid, p_new_secret text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  UPDATE public.api_v2_webhook_endpoints e SET secret = p_new_secret, updated_at = now() WHERE e.user_id = p_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'no_endpoint');
  END IF;
  RETURN public.api_v2_webhook_get(p_user);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_rotate_secret(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_rotate_secret(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.api_v2_webhook_reveal(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT e.secret FROM public.api_v2_webhook_endpoints e WHERE e.user_id = p_user
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_reveal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_reveal(uuid) TO service_role;

-- Removes the endpoint and its notified-state; queued events become failed ("Endpoint removed") so the log stays.
CREATE OR REPLACE FUNCTION public.api_v2_webhook_delete_endpoint(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  DELETE FROM public.api_v2_webhook_endpoints e WHERE e.user_id = p_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('removed', false);
  END IF;
  UPDATE public.api_v2_webhook_events ev SET state = 'failed', last_error = 'Endpoint removed'
   WHERE ev.user_id = p_user AND ev.state = 'pending';
  DELETE FROM public.api_v2_webhook_state st WHERE st.user_id = p_user;
  RETURN jsonb_build_object('removed', true);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_delete_endpoint(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_delete_endpoint(uuid) TO service_role;

-- ============ 4. scan, claim, record ============

-- Queues one order.updated per order whose mapped status is final and differs from the last one notified. Only orders
-- created since the endpoint was saved and within 7 days. One scanner at a time (transaction advisory lock).
CREATE OR REPLACE FUNCTION public.api_v2_webhook_scan(p_now timestamptz, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_limit int := least(greatest(coalesce(p_limit, 500), 1), 2000);
  v_n int := 0;
  e record;
  o record;
  v_id text;
BEGIN
  IF NOT coalesce((SELECT s.enabled FROM public.api_v2_webhook_settings s WHERE s.id = 1), false) THEN
    RETURN 0;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('api_v2_webhook_scan')) THEN
    RETURN 0;   -- another scan is running; the next minute picks up anything left
  END IF;
  FOR e IN SELECT w.user_id, w.created_at FROM public.api_v2_webhook_endpoints w WHERE w.enabled ORDER BY w.user_id LOOP
    FOR o IN
      SELECT x.product, x.reference, x.created_at, x.recipient, x.amount, x.item, x.status, st.last_status AS prev
        FROM public.api_v2_webhook_orders(e.user_id, greatest(e.created_at, v_now - interval '7 days')) x
        LEFT JOIN public.api_v2_webhook_state st
          ON st.user_id = e.user_id AND st.product = x.product AND st.reference = x.reference
       WHERE x.status IN ('completed', 'failed', 'refunded') AND st.last_status IS DISTINCT FROM x.status
       ORDER BY x.created_at
       LIMIT v_limit - v_n
    LOOP
      v_id := 'evt_' || left(replace(gen_random_uuid()::text, '-', ''), 24);
      INSERT INTO public.api_v2_webhook_events (id, user_id, type, payload, next_attempt_at, created_at)
      VALUES (v_id, e.user_id, 'order.updated',
        jsonb_build_object('id', v_id, 'type', 'order.updated', 'created_at', v_now, 'livemode', true,
          'data', jsonb_build_object('product', o.product, 'reference', o.reference, 'status', o.status,
            'previous_status', o.prev, 'recipient', o.recipient, 'amount', o.amount, 'item', o.item,
            'order_created_at', o.created_at)),
        v_now, v_now);
      INSERT INTO public.api_v2_webhook_state AS s (user_id, product, reference, last_status, updated_at)
      VALUES (e.user_id, o.product, o.reference, o.status, v_now)
      ON CONFLICT (user_id, product, reference) DO UPDATE SET last_status = EXCLUDED.last_status, updated_at = EXCLUDED.updated_at;
      v_n := v_n + 1;
    END LOOP;
    EXIT WHEN v_n >= v_limit;
  END LOOP;
  RETURN v_n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_scan(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_scan(timestamptz, integer) TO service_role;

-- Leases up to p_limit due events (at most 10 per person) for 3 minutes and returns them with the url and secret.
CREATE OR REPLACE FUNCTION public.api_v2_webhook_claim(p_now timestamptz, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v jsonb;
BEGIN
  IF NOT coalesce((SELECT s.enabled FROM public.api_v2_webhook_settings s WHERE s.id = 1), false) THEN
    RETURN '[]'::jsonb;
  END IF;
  WITH cand AS (
    SELECT ev.id, ev.next_attempt_at,
           row_number() OVER (PARTITION BY ev.user_id ORDER BY ev.next_attempt_at, ev.id) AS rn
      FROM public.api_v2_webhook_events ev
      JOIN public.api_v2_webhook_endpoints w ON w.user_id = ev.user_id AND w.enabled
     WHERE ev.state = 'pending' AND ev.next_attempt_at <= v_now
  ), pick AS (
    SELECT c.id FROM cand c WHERE c.rn <= 10 ORDER BY c.next_attempt_at, c.id LIMIT v_limit
  ), locked AS (
    SELECT ev.id FROM public.api_v2_webhook_events ev
     WHERE ev.id IN (SELECT p.id FROM pick p) AND ev.state = 'pending' AND ev.next_attempt_at <= v_now
     FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.api_v2_webhook_events ev
       SET attempts = ev.attempts + 1, next_attempt_at = v_now + interval '3 minutes'
      FROM locked l
     WHERE ev.id = l.id
    RETURNING ev.id, ev.user_id, ev.type, ev.payload, ev.attempts, ev.next_attempt_at
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'user_id', u.user_id, 'type', u.type, 'payload', u.payload,
           'attempt', u.attempts, 'url', w.url, 'secret', w.secret) ORDER BY u.id), '[]'::jsonb)
    INTO v
    FROM upd u JOIN public.api_v2_webhook_endpoints w ON w.user_id = u.user_id;
  RETURN v;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_claim(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_claim(timestamptz, integer) TO service_role;

-- Leases one pending event of the caller's (the Send-test button), whatever its next_attempt_at.
CREATE OR REPLACE FUNCTION public.api_v2_webhook_claim_one(p_user uuid, p_event text, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  u record;
  w public.api_v2_webhook_endpoints;
BEGIN
  IF NOT coalesce((SELECT s.enabled FROM public.api_v2_webhook_settings s WHERE s.id = 1), false) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO w FROM public.api_v2_webhook_endpoints e WHERE e.user_id = p_user;
  IF w.user_id IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.api_v2_webhook_events ev
     SET attempts = ev.attempts + 1, next_attempt_at = v_now + interval '3 minutes'
   WHERE ev.id = p_event AND ev.user_id = p_user AND ev.state = 'pending'
  RETURNING ev.id, ev.user_id, ev.type, ev.payload, ev.attempts INTO u;
  IF u.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('id', u.id, 'user_id', u.user_id, 'type', u.type, 'payload', u.payload, 'attempt', u.attempts,
    'url', w.url, 'secret', w.secret);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_claim_one(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_claim_one(uuid, text, timestamptz) TO service_role;

-- Logs one attempt. Only the attempt that holds the current lease (attempts = p_attempt) moves the event: delivered on
-- success, failed once max_attempts is used, else the next retry (1 min, 5 min, 30 min, 2 h, 8 h, 24 h).
CREATE OR REPLACE FUNCTION public.api_v2_webhook_record(p_event text, p_attempt integer, p_ok boolean, p_code integer,
  p_duration_ms integer, p_error text, p_snippet text, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  ev public.api_v2_webhook_events;
  v_state text;
  v_err text := left(nullif(p_error, ''), 200);
BEGIN
  SELECT * INTO ev FROM public.api_v2_webhook_events e WHERE e.id = p_event FOR UPDATE;
  IF ev.id IS NULL THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;
  INSERT INTO public.api_v2_webhook_attempts (event_id, attempt, at, ok, code, duration_ms, error, response_snippet)
  VALUES (p_event, coalesce(p_attempt, 0), v_now, coalesce(p_ok, false), p_code, p_duration_ms, v_err, left(p_snippet, 200));
  IF ev.state <> 'pending' OR ev.attempts IS DISTINCT FROM p_attempt THEN
    RETURN jsonb_build_object('recorded', true, 'stale', true, 'state', ev.state);
  END IF;
  IF coalesce(p_ok, false) THEN
    v_state := 'delivered';
    UPDATE public.api_v2_webhook_events e SET state = v_state, delivered_at = v_now, last_code = p_code, last_error = NULL
     WHERE e.id = p_event;
  ELSIF ev.attempts >= ev.max_attempts THEN
    v_state := 'failed';
    UPDATE public.api_v2_webhook_events e SET state = v_state, last_code = p_code, last_error = v_err WHERE e.id = p_event;
  ELSE
    v_state := 'pending';
    UPDATE public.api_v2_webhook_events e
       SET next_attempt_at = v_now + ('{1 minute,5 minutes,30 minutes,2 hours,8 hours,24 hours}'::interval[])[least(greatest(ev.attempts, 1), 6)],
           last_code = p_code, last_error = v_err
     WHERE e.id = p_event;
  END IF;
  RETURN jsonb_build_object('recorded', true, 'stale', false, 'state', v_state);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_record(text, integer, boolean, integer, integer, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_record(text, integer, boolean, integer, integer, text, text, timestamptz) TO service_role;

-- ============ 5. developer tools ============

CREATE OR REPLACE FUNCTION public.api_v2_webhook_enqueue_test(p_user uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_id text := 'evt_' || left(replace(gen_random_uuid()::text, '-', ''), 24);
BEGIN
  IF NOT coalesce((SELECT s.enabled FROM public.api_v2_webhook_settings s WHERE s.id = 1), false) THEN
    RETURN jsonb_build_object('error', 'disabled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.api_v2_webhook_endpoints e WHERE e.user_id = p_user) THEN
    RETURN jsonb_build_object('error', 'no_endpoint');
  END IF;
  INSERT INTO public.api_v2_webhook_events (id, user_id, type, payload, max_attempts, next_attempt_at, created_at)
  VALUES (v_id, p_user, 'webhook.test',
    jsonb_build_object('id', v_id, 'type', 'webhook.test', 'created_at', v_now, 'livemode', true, 'test', true,
      'data', jsonb_build_object('product', 'data', 'reference', 'TEST-' || upper(substr(v_id, 5, 8)), 'status', 'completed',
        'previous_status', NULL, 'recipient', '0240000000', 'amount', 0, 'item', 'Test event', 'order_created_at', v_now)),
    1, v_now, v_now);
  RETURN jsonb_build_object('id', v_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_enqueue_test(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_enqueue_test(uuid, timestamptz) TO service_role;

-- Re-queues one of the caller's delivered or failed events for a fresh cycle.
CREATE OR REPLACE FUNCTION public.api_v2_webhook_resend(p_user uuid, p_event text, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_state text;
BEGIN
  SELECT ev.state INTO v_state FROM public.api_v2_webhook_events ev WHERE ev.id = p_event AND ev.user_id = p_user FOR UPDATE;
  IF v_state IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_state = 'pending' THEN
    RETURN jsonb_build_object('error', 'pending');
  END IF;
  UPDATE public.api_v2_webhook_events ev
     SET state = 'pending', attempts = 0, next_attempt_at = coalesce(p_now, now()),
         max_attempts = CASE ev.type WHEN 'webhook.test' THEN 1 ELSE 7 END
   WHERE ev.id = p_event;
  RETURN jsonb_build_object('ok', true);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_resend(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_resend(uuid, text, timestamptz) TO service_role;

-- The caller's events, newest first, keyset (created_at, id), each with its last 10 attempts.
CREATE OR REPLACE FUNCTION public.api_v2_webhook_deliveries(p_user uuid, p_before_at timestamptz, p_before_id text, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v jsonb;
BEGIN
  IF p_user IS NULL OR (p_before_at IS NULL) <> (p_before_id IS NULL) THEN
    RETURN '[]'::jsonb;   -- a cursor is both parts or none
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ev.id, 'type', ev.type, 'state', ev.state, 'attempts', ev.attempts,
           'next_attempt_at', CASE WHEN ev.state = 'pending' THEN ev.next_attempt_at END, 'last_code', ev.last_code,
           'last_error', ev.last_error, 'delivered_at', ev.delivered_at, 'created_at', ev.created_at, 'payload', ev.payload,
           'attempts_log', (SELECT coalesce(jsonb_agg(jsonb_build_object('attempt', a.attempt, 'at', a.at, 'ok', a.ok, 'code', a.code,
                              'duration_ms', a.duration_ms, 'error', a.error, 'snippet', a.response_snippet) ORDER BY a.at DESC, a.id DESC), '[]'::jsonb)
                              FROM (SELECT * FROM public.api_v2_webhook_attempts x WHERE x.event_id = ev.id ORDER BY x.at DESC, x.id DESC LIMIT 10) a))
           ORDER BY ev.created_at DESC, ev.id DESC), '[]'::jsonb)
    INTO v
    FROM (
      SELECT * FROM public.api_v2_webhook_events e
       WHERE e.user_id = p_user AND (p_before_at IS NULL OR (e.created_at, e.id) < (p_before_at, p_before_id))
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT v_limit
    ) ev;
  RETURN v;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_deliveries(uuid, timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_deliveries(uuid, timestamptz, text, integer) TO service_role;

-- ============ 6. admin switch ============

CREATE OR REPLACE FUNCTION public.api_v2_webhook_settings_get(p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_day timestamptz := date_trunc('day', coalesce(p_now, now()) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  s public.api_v2_webhook_settings;
BEGIN
  SELECT * INTO s FROM public.api_v2_webhook_settings x WHERE x.id = 1;
  RETURN jsonb_build_object('enabled', coalesce(s.enabled, false), 'updated_at', s.updated_at,
    'endpoints', (SELECT count(*) FROM public.api_v2_webhook_endpoints e WHERE e.enabled),
    'today', (SELECT jsonb_build_object('pending', count(*) FILTER (WHERE ev.state = 'pending'),
                                        'delivered', count(*) FILTER (WHERE ev.state = 'delivered'),
                                        'failed', count(*) FILTER (WHERE ev.state = 'failed'))
                FROM public.api_v2_webhook_events ev WHERE ev.created_at >= v_day));
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_settings_get(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_settings_get(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.api_v2_webhook_settings_set(p_enabled boolean, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_actor IS NULL OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'actor and value required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.api_v2_webhook_settings s SET enabled = p_enabled, updated_at = now(), updated_by = p_actor
   WHERE s.id = 1 AND s.enabled IS DISTINCT FROM p_enabled;
  RETURN jsonb_build_object('changed', FOUND, 'enabled', p_enabled);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_settings_set(boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_settings_set(boolean, uuid) TO service_role;

-- ============ 7. retention ============

CREATE OR REPLACE FUNCTION public.api_v2_webhook_retention(p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_ids text[];
  v_state int;
BEGIN
  SELECT array_agg(e.id) INTO v_ids
    FROM (SELECT x.id FROM public.api_v2_webhook_events x WHERE x.created_at < v_now - interval '30 days' ORDER BY x.created_at LIMIT 5000) e;
  IF v_ids IS NOT NULL THEN
    DELETE FROM public.api_v2_webhook_attempts a WHERE a.event_id = ANY (v_ids);
    DELETE FROM public.api_v2_webhook_events e WHERE e.id = ANY (v_ids);
  END IF;
  WITH gone AS (
    DELETE FROM public.api_v2_webhook_state st
     WHERE (st.user_id, st.product, st.reference) IN (
       SELECT x.user_id, x.product, x.reference FROM public.api_v2_webhook_state x
        WHERE x.updated_at < v_now - interval '8 days' ORDER BY x.updated_at LIMIT 5000)
    RETURNING 1)
  SELECT count(*) INTO v_state FROM gone;
  RETURN jsonb_build_object('events', coalesce(array_length(v_ids, 1), 0), 'state', v_state);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_webhook_retention(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_webhook_retention(timestamptz) TO service_role;

COMMIT;
