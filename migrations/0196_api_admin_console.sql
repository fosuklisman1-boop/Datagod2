-- 0196_api_admin_console.sql
--
-- API admin console release (R4), Task 1: three new service-role-only tables and nine SECURITY DEFINER functions behind the
-- admin API console (developer pause, per-service pause, announcements, and the read side of the Developers, Overview, Report
-- and public status views). ADDITIVE; NOT applied by the implementing agent. One transaction. Idempotent (IF NOT EXISTS /
-- OR REPLACE / ON CONFLICT DO NOTHING for the seeds). Nothing reads any of it yet, and no existing table or function is altered.
--
--   api_v2_developer_pauses   user_id pk (no foreign key), paused_at, paused_by, reason (3-200). A row means "paused";
--                             unpausing deletes the row and the audit row keeps the history (same shape as api_v2_access_grants).
--   api_v2_service_controls   service pk (data, airtime, bills, bundles, results, afa, sms), paused, message (<= 200), updated_at,
--                             updated_by. Seeded with the seven rows, paused = false, so applying this changes nothing.
--   api_v2_announcements      id, title (1-80), body (1-1000), severity (info, warning, critical), starts_at, ends_at (> starts_at),
--                             created_by, created_at, updated_at. At most 50 rows, enforced by the save function.
--
-- Write functions (EXECUTE: service_role only). Each refuses a NULL actor (raises 'actor is required'), validates, writes its
-- admin_audit_log row in the same transaction on a real change only, and returns jsonb
--   success {"ok":true,"changed":bool,...}      failure {"ok":false,"code":"not_found"|"bad_reason"|"bad_message"|"bad_input"|"too_many"}
-- A failure changes and audits nothing. A repeated pause or resume is {"ok":true,"changed":false} with no audit row.
--   api_v2_set_developer_pause(p_user, p_paused, p_reason, p_actor)   audit api_developer_pause / api_developer_unpause, target = the developer.
--                             Touches only its own pause row: it never reads or locks api_v2_keys, grants or logs.
--   api_v2_set_service_pause(p_service, p_paused, p_message, p_actor) audit api_service_pause / api_service_resume with before and after
--                             {service, paused, message}. The message is trimmed, empty becomes NULL, control and bidi-override
--                             characters are refused, and it is cleared when resuming.
--   api_v2_announcement_save(p_id, p_title, p_body, p_severity, p_starts, p_ends, p_actor)   NULL id = create. Audit api_announcement_save
--                             stores id, title, severity and dates only (never the body). The 50-row cap is checked under an advisory lock.
--   api_v2_announcement_delete(p_id, p_actor)                         audit api_announcement_delete.
-- Read functions (STABLE, bounded, service-role only):
--   api_v2_developers(p_since, p_search, p_limit, p_offset)           {total, items[]}; a developer = any api_v2_keys row, a grant, or a pause
--                             row. p_limit is clamped to 1..100 (default 25), p_offset to 0..100000, p_search is cut to 60 characters and
--                             matched with ilike after escaping backslash, % and _.
--   api_v2_developer_profile(p_user, p_since)                         {user, totals, daily[], keys[], orders[], grant, pause, audit[]}, or SQL NULL
--                             for an unknown user. Totals are attributed by the user's api_v2_keys (so they equal api_v2_key_activity summed over
--                             the keys). orders = the 20 newest, any status, recipient_phone MASKED to the last 4 digits inside the function.
--   api_v2_overview_trend(p_since)                                    [{day 'YYYY-MM-DD' (UTC), requests, ok, failed, revenue}], ascending. A day with
--                             neither requests nor orders is ABSENT (the caller fills gaps). p_since defaults to 30 days and is capped at 400.
--   api_v2_business_report(p_from, p_to)                              flat rows [{month 'YYYY-MM' (UTC), user_id, developer, email, product (the order's
--                             network), orders, revenue, costed_orders, costed_revenue, cost_total}] for created_at in [p_from, p_to), at most
--                             20001 rows (the caller treats 20001 as "too many"). The supplier-cost join lives only here: a cost is never guessed,
--                             an order with no cost row or no package counts as not costed. Raises 'from and to are required' and 'range too large'
--                             (over 800 days); an empty or inverted range returns [].
--   api_v2_public_health(p_since)                                     [{endpoint, total, failed}] for environment 'live' only (failed = status >= 500),
--                             no user, key or address field. p_since defaults to 24 hours and is capped at 7 days.
-- Money rule everywhere (identical to 0131): an order counts when status NOT IN ('failed','refunded'), attributed by
-- api_orders.api_v2_key_id IS NOT NULL. api_v2_admin_stats and api_v2_key_activity (0131) are reused unchanged.
--
-- Locks. SECURITY DEFINER with a pinned search_path (public, pg_temp), schema-qualified names, write functions with lock_timeout 5s.
-- Every function is plpgsql, so none needs a table to exist when it is created and the functions come first.
--
-- LOCKS taken by this file (lock_timeout 2s bounds only the WAIT to acquire a lock, not how long it is held; every lock below is held
-- until the transaction ends, which for the dry run includes the whole self-test). Statements are ordered so the one lock on a table
-- other people use comes last:
--   auth.users          NO lock: api_v2_developer_pauses has no foreign key to auth.users (a foreign key would take SHARE ROW EXCLUSIVE and block
--                       sign-in and token refresh until the transaction ends). api_v2_set_developer_pause checks public.users instead, and
--                       a pause row for a user deleted later is harmless (it matches no request).
--   Everything else (the new functions, api_v2_service_controls, api_v2_announcements, their seeds and grants) takes no lock that touches
--   live traffic. NO ALTER of api_v2_keys, api_v2_logs, api_v2_config or api_orders, and no index on them.
-- Apply in a quiet window, with the dry run measured first.
-- A lock timeout (SQLSTATE 55P03) is harmless and safe to retry: nothing is applied, so just run it again. A statement timeout is the same.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.api_v2_developer_pauses'), to_regclass('public.api_v2_service_controls'), to_regclass('public.api_v2_announcements');   -- NULL, NULL, NULL
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
--      AND p.proname IN ('api_v2_set_developer_pause','api_v2_set_service_pause','api_v2_announcement_save','api_v2_announcement_delete',
--      'api_v2_developers','api_v2_developer_profile','api_v2_overview_trend','api_v2_business_report','api_v2_public_health');   -- 0
--   SELECT to_regclass('public.admin_audit_log');                                                       -- NOT NULL (0069 + 0176 applied)
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.admin_audit_log'::regclass AND contype = 'c';   -- no CHECK on action (the five new actions need none)
--   SELECT to_regclass('public.api_v2_access_grants');                                                  -- NOT NULL (0195 applied: api_v2_developers reads it)
--   SELECT to_regprocedure('public.api_v2_key_activity(uuid,timestamptz)'), to_regprocedure('public.api_v2_admin_stats(timestamptz)');   -- both NOT NULL (0131)
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_orders'
--      AND column_name IN ('api_v2_key_id','package_id','network','price','recipient_phone','api_reference','volume_gb');   -- 7 rows
--   SELECT to_regclass('public.package_costs');                                                         -- NOT NULL (0187 applied: the report cost join)
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'
--      AND column_name IN ('first_name','last_name','email','role','is_suspended');                     -- 5 rows
--   The seven service names: data, airtime, bills, bundles, results, afa, sms (equal to DocSlug in lib/api-v2/docs/pages.ts).
--
-- VERIFY after applying:
--   SELECT has_table_privilege('anon','public.api_v2_developer_pauses','SELECT'), has_table_privilege('authenticated','public.api_v2_announcements','SELECT');   -- false, false
--   SELECT has_function_privilege('authenticated','public.api_v2_set_developer_pause(uuid,boolean,text,uuid)','EXECUTE'), has_function_privilege('service_role','public.api_v2_set_developer_pause(uuid,boolean,text,uuid)','EXECUTE');   -- false, true
--   SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('api_v2_developer_pauses','api_v2_service_controls','api_v2_announcements');   -- all true
--   SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('api_v2_developer_pauses','api_v2_service_controls','api_v2_announcements');   -- 0
--   SELECT count(*), count(*) FILTER (WHERE paused) FROM public.api_v2_service_controls;                 -- 7, 0
--   SELECT count(*) FROM public.api_v2_developer_pauses;                                                 -- 0
--
-- Dry run: migrations/0196_api_admin_console.selftest.sql (build the run string by code, as lib/api-v2/migration-0196.test.ts does).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

-- ============ 1. functions (no table has to exist, so they come first and take no lock on live traffic) ============

-- pause or unpause one developer
CREATE OR REPLACE FUNCTION public.api_v2_set_developer_pause(p_user uuid, p_paused boolean, p_reason text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_reason text;
  v_n bigint;
  v_old record;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  IF p_paused IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_input');
  END IF;
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  IF p_paused THEN
    v_reason := regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g');
    IF char_length(v_reason) < 3 OR char_length(v_reason) > 200
       OR v_reason ~ '[\x01-\x1F\x7F-\x9F\xA0\xAD\u061C\u115F\u1160\u180E\u2000-\u200F\u2028-\u202E\u2060-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0]' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_reason');
    END IF;
    INSERT INTO public.api_v2_developer_pauses (user_id, paused_by, reason)
    VALUES (p_user, p_actor, v_reason)
    ON CONFLICT (user_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      RETURN jsonb_build_object('ok', true, 'changed', false, 'user_id', p_user, 'paused', true);
    END IF;
    INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
    VALUES (p_actor, 'api_developer_pause', p_user, NULL, jsonb_build_object('reason', v_reason));
    RETURN jsonb_build_object('ok', true, 'changed', true, 'user_id', p_user, 'paused', true);
  END IF;

  DELETE FROM public.api_v2_developer_pauses d WHERE d.user_id = p_user
    RETURNING d.paused_at, d.paused_by, d.reason INTO v_old;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'user_id', p_user, 'paused', false);
  END IF;
  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor, 'api_developer_unpause', p_user,
          jsonb_build_object('paused_at', v_old.paused_at, 'paused_by', v_old.paused_by, 'reason', v_old.reason), NULL);
  RETURN jsonb_build_object('ok', true, 'changed', true, 'user_id', p_user, 'paused', false);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_set_developer_pause(uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_set_developer_pause(uuid, boolean, text, uuid) TO service_role;

-- pause or resume one service
CREATE OR REPLACE FUNCTION public.api_v2_set_service_pause(p_service text, p_paused boolean, p_message text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_msg text;
  v_old record;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  IF p_paused IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_input');
  END IF;

  IF p_paused THEN
    v_msg := regexp_replace(coalesce(p_message, ''), '^\s+|\s+$', '', 'g');
    IF v_msg = '' THEN
      v_msg := NULL;
    ELSIF char_length(v_msg) > 200
       OR v_msg ~ '[\x01-\x1F\x7F-\x9F\xA0\xAD\u061C\u115F\u1160\u180E\u2000-\u200F\u2028-\u202E\u2060-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0]' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_message');
    END IF;
  ELSE
    v_msg := NULL; -- resuming clears the message
  END IF;

  SELECT c.paused, c.message INTO v_old
    FROM public.api_v2_service_controls c WHERE c.service = p_service
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_old.paused IS NOT DISTINCT FROM p_paused AND v_old.message IS NOT DISTINCT FROM v_msg THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'service', p_service, 'paused', p_paused, 'message', v_msg);
  END IF;

  UPDATE public.api_v2_service_controls c
     SET paused = p_paused, message = v_msg, updated_at = now(), updated_by = p_actor
   WHERE c.service = p_service;

  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor,
          CASE WHEN p_paused THEN 'api_service_pause' ELSE 'api_service_resume' END,
          NULL,
          jsonb_build_object('service', p_service, 'paused', v_old.paused, 'message', v_old.message),
          jsonb_build_object('service', p_service, 'paused', p_paused, 'message', v_msg));
  RETURN jsonb_build_object('ok', true, 'changed', true, 'service', p_service, 'paused', p_paused, 'message', v_msg);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_set_service_pause(text, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_set_service_pause(text, boolean, text, uuid) TO service_role;

-- create or update one announcement
CREATE OR REPLACE FUNCTION public.api_v2_announcement_save(
  p_id uuid, p_title text, p_body text, p_severity text, p_starts timestamptz, p_ends timestamptz, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  c_max CONSTANT int := 50;
  v_title text;
  v_body text;
  v_id uuid;
  v_old record;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required';
  END IF;

  v_title := regexp_replace(coalesce(p_title, ''), '^\s+|\s+$', '', 'g');
  v_body := regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g');
  -- title: one line, no control or bidi-override characters; body: the same but line breaks and tabs are allowed
  IF char_length(v_title) < 1 OR char_length(v_title) > 80
     OR v_title ~ '[\x01-\x1F\x7F-\x9F\xA0\xAD\u061C\u115F\u1160\u180E\u2000-\u200F\u2028-\u202E\u2060-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0]'
     OR char_length(v_body) < 1 OR char_length(v_body) > 1000
     OR v_body ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\xA0\xAD\u061C\u115F\u1160\u180E\u2000-\u200F\u2028-\u202E\u2060-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0]'
     OR p_severity IS NULL OR p_severity NOT IN ('info', 'warning', 'critical')
     OR p_starts IS NULL OR p_ends IS NULL OR p_ends <= p_starts THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_input');
  END IF;

  IF p_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('api_v2_announcements'));
    IF (SELECT count(*) FROM public.api_v2_announcements) >= c_max THEN
      RETURN jsonb_build_object('ok', false, 'code', 'too_many');
    END IF;
    INSERT INTO public.api_v2_announcements (title, body, severity, starts_at, ends_at, created_by)
    VALUES (v_title, v_body, p_severity, p_starts, p_ends, p_actor)
    RETURNING id INTO v_id;
    INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
    VALUES (p_actor, 'api_announcement_save', NULL, NULL,
            jsonb_build_object('id', v_id, 'title', v_title, 'severity', p_severity, 'starts_at', p_starts, 'ends_at', p_ends));
    RETURN jsonb_build_object('ok', true, 'changed', true, 'id', v_id);
  END IF;

  SELECT a.title, a.body, a.severity, a.starts_at, a.ends_at INTO v_old
    FROM public.api_v2_announcements a WHERE a.id = p_id
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_old.title = v_title AND v_old.body = v_body AND v_old.severity = p_severity
     AND v_old.starts_at = p_starts AND v_old.ends_at = p_ends THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'id', p_id);
  END IF;
  UPDATE public.api_v2_announcements a
     SET title = v_title, body = v_body, severity = p_severity, starts_at = p_starts, ends_at = p_ends, updated_at = now()
   WHERE a.id = p_id;
  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor, 'api_announcement_save', NULL,
          jsonb_build_object('id', p_id, 'title', v_old.title, 'severity', v_old.severity, 'starts_at', v_old.starts_at, 'ends_at', v_old.ends_at),
          jsonb_build_object('id', p_id, 'title', v_title, 'severity', p_severity, 'starts_at', p_starts, 'ends_at', p_ends));
  RETURN jsonb_build_object('ok', true, 'changed', true, 'id', p_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_announcement_save(uuid, text, text, text, timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_announcement_save(uuid, text, text, text, timestamptz, timestamptz, uuid) TO service_role;

-- delete one announcement
CREATE OR REPLACE FUNCTION public.api_v2_announcement_delete(p_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_old record;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  DELETE FROM public.api_v2_announcements a WHERE a.id = p_id
    RETURNING a.title, a.severity, a.starts_at, a.ends_at INTO v_old;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor, 'api_announcement_delete', NULL,
          jsonb_build_object('id', p_id, 'title', v_old.title, 'severity', v_old.severity, 'starts_at', v_old.starts_at, 'ends_at', v_old.ends_at),
          NULL);
  RETURN jsonb_build_object('ok', true, 'changed', true, 'id', p_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_announcement_delete(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_announcement_delete(uuid, uuid) TO service_role;

-- developer list (read only)
CREATE OR REPLACE FUNCTION public.api_v2_developers(p_since timestamptz, p_search text, p_limit int, p_offset int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  v_since timestamptz := greatest(coalesce(p_since, now() - interval '30 days'), now() - interval '400 days');
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_q text := left(regexp_replace(coalesce(p_search, ''), '^\s+|\s+$', '', 'g'), 60);
  v_pat text;
  v_total int;
  v_items jsonb;
BEGIN
  IF v_q <> '' THEN
    v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  WITH dev AS (
    SELECT k.user_id AS id FROM public.api_v2_keys k
    UNION
    SELECT g.user_id FROM public.api_v2_access_grants g
    UNION
    SELECT p.user_id FROM public.api_v2_developer_pauses p
  ),
  f AS (
    SELECT d.id, us.first_name, us.last_name, us.email, us.role, coalesce(us.is_suspended, false) AS susp
      FROM dev d
      LEFT JOIN public.users us ON us.id = d.id
     WHERE v_pat IS NULL
        OR concat_ws(' ', us.first_name, us.last_name) ILIKE v_pat ESCAPE '\'
        OR us.email ILIKE v_pat ESCAPE '\'
  ),
  ks AS (
    SELECT k.user_id,
           count(*) FILTER (WHERE k.status = 'active') AS ka,
           count(*) FILTER (WHERE k.status = 'pending') AS kp,
           max(k.last_used_at) AS lu
      FROM public.api_v2_keys k
     WHERE k.user_id IN (SELECT id FROM f)
     GROUP BY k.user_id
  ),
  pg AS (
    SELECT f.id, f.first_name, f.last_name, f.email, f.role, f.susp, ks.ka, ks.kp, ks.lu
      FROM f LEFT JOIN ks ON ks.user_id = f.id
     ORDER BY ks.lu DESC NULLS LAST, f.id
     LIMIT v_limit OFFSET v_offset
  )
  SELECT
    (SELECT count(*)::int FROM f),
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'user_id', p.id,
        'first_name', p.first_name,
        'last_name', p.last_name,
        'email', p.email,
        'role', p.role,
        'is_suspended', p.susp,
        'keys_active', coalesce(p.ka, 0),
        'keys_pending', coalesce(p.kp, 0),
        'last_used_at', p.lu,
        'requests', a.requests,
        'ok', a.ok,
        'failed', a.failed,
        'spent', a.spent,
        'orders', a.orders,
        'granted', EXISTS (SELECT 1 FROM public.api_v2_access_grants g WHERE g.user_id = p.id),
        'paused', pz.user_id IS NOT NULL,
        'paused_at', pz.paused_at
      ) ORDER BY p.lu DESC NULLS LAST, p.id), '[]'::jsonb)
       FROM pg p
       LEFT JOIN public.api_v2_developer_pauses pz ON pz.user_id = p.id
       CROSS JOIN LATERAL (
         SELECT
           (SELECT count(*) FROM public.api_v2_logs l
             WHERE l.key_id IN (SELECT k.id FROM public.api_v2_keys k WHERE k.user_id = p.id) AND l.created_at >= v_since) AS requests,
           (SELECT count(*) FROM public.api_v2_logs l
             WHERE l.key_id IN (SELECT k.id FROM public.api_v2_keys k WHERE k.user_id = p.id) AND l.created_at >= v_since
               AND l.status_code BETWEEN 200 AND 399) AS ok,
           (SELECT count(*) FROM public.api_v2_logs l
             WHERE l.key_id IN (SELECT k.id FROM public.api_v2_keys k WHERE k.user_id = p.id) AND l.created_at >= v_since
               AND l.status_code >= 400) AS failed,
           (SELECT coalesce(sum(o.price), 0) FROM public.api_orders o
             WHERE o.api_v2_key_id IN (SELECT k.id FROM public.api_v2_keys k WHERE k.user_id = p.id) AND o.created_at >= v_since
               AND o.status NOT IN ('failed', 'refunded')) AS spent,
           (SELECT count(*) FROM public.api_orders o
             WHERE o.api_v2_key_id IN (SELECT k.id FROM public.api_v2_keys k WHERE k.user_id = p.id) AND o.created_at >= v_since
               AND o.status NOT IN ('failed', 'refunded')) AS orders
       ) a)
  INTO v_total, v_items;

  RETURN jsonb_build_object('total', v_total, 'items', v_items);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_developers(timestamptz, text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_developers(timestamptz, text, int, int) TO service_role;

-- one developer's profile (read only)
CREATE OR REPLACE FUNCTION public.api_v2_developer_profile(p_user uuid, p_since timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  v_since timestamptz := greatest(coalesce(p_since, now() - interval '30 days'), now() - interval '400 days');
  v_user jsonb;
  v_keyids uuid[];
  v_totals jsonb;
  v_daily jsonb;
  v_keys jsonb;
  v_orders jsonb;
  v_grant jsonb;
  v_pause jsonb;
  v_audit jsonb;
BEGIN
  IF p_user IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT jsonb_build_object('id', u.id, 'first_name', u.first_name, 'last_name', u.last_name, 'email', u.email,
                            'role', u.role, 'is_suspended', coalesce(u.is_suspended, false))
    INTO v_user FROM public.users u WHERE u.id = p_user;
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(array_agg(k.id), '{}'::uuid[]) INTO v_keyids FROM public.api_v2_keys k WHERE k.user_id = p_user;

  SELECT jsonb_build_object(
    'requests', (SELECT count(*) FROM public.api_v2_logs l WHERE l.key_id = ANY (v_keyids) AND l.created_at >= v_since),
    'ok',       (SELECT count(*) FROM public.api_v2_logs l WHERE l.key_id = ANY (v_keyids) AND l.created_at >= v_since
                   AND l.status_code BETWEEN 200 AND 399),
    'failed',   (SELECT count(*) FROM public.api_v2_logs l WHERE l.key_id = ANY (v_keyids) AND l.created_at >= v_since
                   AND l.status_code >= 400),
    'spent',    (SELECT coalesce(sum(o.price), 0) FROM public.api_orders o WHERE o.api_v2_key_id = ANY (v_keyids)
                   AND o.created_at >= v_since AND o.status NOT IN ('failed', 'refunded')),
    'orders',   (SELECT count(*) FROM public.api_orders o WHERE o.api_v2_key_id = ANY (v_keyids)
                   AND o.created_at >= v_since AND o.status NOT IN ('failed', 'refunded')),
    'pending',  (SELECT count(*) FROM public.api_orders o WHERE o.api_v2_key_id = ANY (v_keyids)
                   AND o.created_at >= v_since AND o.status IN ('pending', 'processing', 'held_registration'))
  ) INTO v_totals;

  WITH l AS (
    SELECT to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           count(*) AS n,
           count(*) FILTER (WHERE x.status_code BETWEEN 200 AND 399) AS ok,
           count(*) FILTER (WHERE x.status_code >= 400) AS failed
      FROM public.api_v2_logs x
     WHERE x.key_id = ANY (v_keyids) AND x.created_at >= v_since
     GROUP BY 1
  ),
  o AS (
    SELECT to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, coalesce(sum(x.price), 0) AS rev
      FROM public.api_orders x
     WHERE x.api_v2_key_id = ANY (v_keyids) AND x.created_at >= v_since AND x.status NOT IN ('failed', 'refunded')
     GROUP BY 1
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'day', d.day, 'requests', coalesce(l.n, 0), 'ok', coalesce(l.ok, 0), 'failed', coalesce(l.failed, 0),
           'revenue', coalesce(o.rev, 0)) ORDER BY d.day), '[]'::jsonb)
    INTO v_daily
    FROM (SELECT l2.day FROM l l2 UNION SELECT o2.day FROM o o2) d
    LEFT JOIN l ON l.day = d.day
    LEFT JOIN o ON o.day = d.day;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', k.id, 'key_type', k.key_type, 'environment', k.environment, 'status', k.status, 'name', k.name,
           'key_prefix', k.key_prefix, 'created_at', k.created_at, 'last_used_at', k.last_used_at,
           'activity', public.api_v2_key_activity(k.id, v_since)) ORDER BY k.created_at, k.id), '[]'::jsonb)
    INTO v_keys FROM public.api_v2_keys k WHERE k.user_id = p_user;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'reference', t.api_reference, 'network', t.network, 'volume_gb', t.volume_gb, 'price', t.price,
           'status', t.status, 'created_at', t.created_at,
           'recipient_phone', CASE WHEN t.recipient_phone IS NULL THEN NULL
                                   WHEN char_length(t.recipient_phone) <= 4 THEN repeat('*', char_length(t.recipient_phone))
                                   ELSE repeat('*', char_length(t.recipient_phone) - 4) || right(t.recipient_phone, 4) END
         ) ORDER BY t.created_at DESC, t.id DESC), '[]'::jsonb)
    INTO v_orders
    FROM (SELECT o.* FROM public.api_orders o WHERE o.api_v2_key_id = ANY (v_keyids)
           ORDER BY o.created_at DESC, o.id DESC LIMIT 20) t;

  SELECT jsonb_build_object('granted_at', g.granted_at, 'granted_by', g.granted_by)
    INTO v_grant FROM public.api_v2_access_grants g WHERE g.user_id = p_user;
  SELECT jsonb_build_object('paused_at', p.paused_at, 'paused_by', p.paused_by, 'reason', p.reason)
    INTO v_pause FROM public.api_v2_developer_pauses p WHERE p.user_id = p_user;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'action', a.action, 'admin_id', a.admin_id, 'created_at', a.created_at,
           'reason', coalesce(a.new_value ->> 'reason', a.old_value ->> 'reason')) ORDER BY a.created_at DESC, a.id DESC), '[]'::jsonb)
    INTO v_audit
    FROM (SELECT x.* FROM public.admin_audit_log x
           WHERE x.target_user_id = p_user AND x.action LIKE 'api\_%'
           ORDER BY x.created_at DESC, x.id DESC LIMIT 5) a;

  RETURN jsonb_build_object('user', v_user, 'totals', v_totals, 'daily', v_daily, 'keys', v_keys, 'orders', v_orders,
                            'grant', v_grant, 'pause', v_pause, 'audit', v_audit);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_developer_profile(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_developer_profile(uuid, timestamptz) TO service_role;

-- per-day trend for the overview (read only)
CREATE OR REPLACE FUNCTION public.api_v2_overview_trend(p_since timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  v_since timestamptz := greatest(coalesce(p_since, now() - interval '30 days'), now() - interval '400 days');
  v_r jsonb;
BEGIN
  WITH l AS (
    SELECT to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           count(*) AS n,
           count(*) FILTER (WHERE x.status_code BETWEEN 200 AND 399) AS ok,
           count(*) FILTER (WHERE x.status_code >= 400) AS failed
      FROM public.api_v2_logs x
     WHERE x.created_at >= v_since
     GROUP BY 1
  ),
  o AS (
    SELECT to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, coalesce(sum(x.price), 0) AS rev
      FROM public.api_orders x
     WHERE x.api_v2_key_id IS NOT NULL AND x.created_at >= v_since AND x.status NOT IN ('failed', 'refunded')
     GROUP BY 1
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'day', d.day, 'requests', coalesce(l.n, 0), 'ok', coalesce(l.ok, 0), 'failed', coalesce(l.failed, 0),
           'revenue', coalesce(o.rev, 0)) ORDER BY d.day), '[]'::jsonb)
    INTO v_r
    FROM (SELECT l2.day FROM l l2 UNION SELECT o2.day FROM o o2) d
    LEFT JOIN l ON l.day = d.day
    LEFT JOIN o ON o.day = d.day;
  RETURN v_r;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_overview_trend(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_overview_trend(timestamptz) TO service_role;

-- business report (read only; the only place the supplier cost is joined)
CREATE OR REPLACE FUNCTION public.api_v2_business_report(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  c_cap CONSTANT int := 20001;
  v_r jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'from and to are required';
  END IF;
  IF p_to <= p_from THEN
    RETURN '[]'::jsonb;
  END IF;
  IF p_to - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'range too large';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'month', r.month, 'user_id', r.user_id, 'developer', r.developer, 'email', r.email, 'product', r.product,
           'orders', r.orders, 'revenue', r.revenue, 'costed_orders', r.costed_orders,
           'costed_revenue', r.costed_revenue, 'cost_total', r.cost_total
         ) ORDER BY r.month, r.developer NULLS LAST, r.user_id, r.product), '[]'::jsonb)
    INTO v_r
    FROM (
      SELECT to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
             o.user_id AS user_id,
             nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS developer,
             u.email AS email,
             o.network AS product,
             count(*) AS orders,
             coalesce(sum(o.price), 0) AS revenue,
             count(pc.package_id) AS costed_orders,
             coalesce(sum(o.price) FILTER (WHERE pc.package_id IS NOT NULL), 0) AS costed_revenue,
             coalesce(sum(pc.cost_price), 0) AS cost_total
        FROM public.api_orders o
        LEFT JOIN public.users u ON u.id = o.user_id
        LEFT JOIN public.package_costs pc ON pc.package_id = o.package_id
       WHERE o.api_v2_key_id IS NOT NULL
         AND o.created_at >= p_from AND o.created_at < p_to
         AND o.status NOT IN ('failed', 'refunded')
       GROUP BY 1, 2, 3, 4, 5
       ORDER BY 1, 3 NULLS LAST, 2, 5
       LIMIT c_cap
    ) r;
  RETURN v_r;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_business_report(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_business_report(timestamptz, timestamptz) TO service_role;

-- public status numbers (read only; no user, key or address field)
CREATE OR REPLACE FUNCTION public.api_v2_public_health(p_since timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  v_since timestamptz := greatest(coalesce(p_since, now() - interval '24 hours'), now() - interval '7 days');
  v_r jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'total', s.total, 'failed', s.failed)
                            ORDER BY s.endpoint), '[]'::jsonb)
    INTO v_r
    FROM (
      SELECT l.endpoint,
             count(*) AS total,
             count(*) FILTER (WHERE l.status_code >= 500) AS failed
        FROM public.api_v2_logs l
       WHERE l.environment = 'live' AND l.created_at >= v_since AND l.endpoint IS NOT NULL
       GROUP BY l.endpoint
       ORDER BY count(*) DESC, l.endpoint
       LIMIT 200
    ) s;
  RETURN v_r;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_public_health(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_public_health(timestamptz) TO service_role;

-- ============ 2. new tables (no foreign keys at all, so no lock on any existing table) ============
CREATE TABLE IF NOT EXISTS public.api_v2_service_controls (
  service text PRIMARY KEY CHECK (service IN ('data', 'airtime', 'bills', 'bundles', 'results', 'afa', 'sms')),
  paused boolean NOT NULL DEFAULT false,
  message text CHECK (message IS NULL OR char_length(message) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.api_v2_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_v2_announcements_window CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS api_v2_announcements_window_idx ON public.api_v2_announcements (ends_at, starts_at);

-- seeds: seven rows, nothing paused, so applying this changes no behaviour (an existing row is never touched)
INSERT INTO public.api_v2_service_controls (service)
VALUES ('data'), ('airtime'), ('bills'), ('bundles'), ('results'), ('afa'), ('sms')
ON CONFLICT (service) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.api_v2_developer_pauses (
  user_id uuid PRIMARY KEY, -- no foreign key (it would lock auth.users); api_v2_set_developer_pause checks public.users
  paused_at timestamptz NOT NULL DEFAULT now(),
  paused_by uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200)
);

-- service_role only: RLS on, no policies, every client privilege revoked (0060 grants authenticated CRUD by default).
ALTER TABLE public.api_v2_service_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_developer_pauses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_v2_service_controls FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.api_v2_announcements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.api_v2_developer_pauses FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_v2_service_controls TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_v2_announcements TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_v2_developer_pauses TO service_role;

COMMIT;
