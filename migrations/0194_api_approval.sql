-- 0194_api_approval.sql
--
-- API approval release, Task 1: schema and atomic decision functions for admin approval of live API keys and of API access.
-- ADDITIVE; service-role only. NOT applied by the implementing agent. One transaction. Idempotent (IF NOT EXISTS /
-- OR REPLACE / re-runnable). Nothing reads it yet.
--
--   api_v2_config.approval_whatsapp           text null (digits only; the app builds the link)
--   api_v2_keys                               + request_code (unique, null), rejected_at, rejected_by, reject_reason.
--                                             A rejected key is status 'revoked' plus rejected_at, so no status reader changes.
--                                             Existing PENDING LIVE keys are backfilled with a code; active keys get none.
--   api_v2_keys_one_live_per_type             REPLACED by two partial unique indexes on (user_id, key_type, environment):
--                                             api_v2_keys_one_active_per_slot (status 'active') and
--                                             api_v2_keys_one_pending_per_slot (status 'pending'). So an active key and a
--                                             pending replacement can coexist. Both new indexes are built before the old one is dropped.
--   api_v2_access_requests                    id, user_id, request_code unique, status (pending/approved/rejected/cancelled),
--                                             reason (the admin's rejection reason), created_at, decided_at, decided_by. One pending row per user.
--   api_v2_access_grants                      user_id primary key, granted_by, granted_at, request_id. Removing deletes the row;
--                                             the audit row keeps the history.
--   api_v2_logs.error_reason                  text null.
--
-- Codes: 'API-' + 6 characters from 23456789ABCDEFGHJKMNPQRSTUVWXYZ (no 0, O, 1, I, L). Randomness is gen_random_uuid()
-- (cryptographic); bytes of 248 or more are skipped so there is no modulo bias; the helper retries on a collision with
-- either table. The backfill retries a unique violation.
--
-- Decision functions (all SECURITY DEFINER, search_path = public, pg_temp, lock_timeout 5s; EXECUTE revoked from
-- PUBLIC / anon / authenticated, granted to service_role). Each refuses a NULL actor (raises 'actor is required'), writes its
-- audit row (admin_audit_log, api_* action) in the same transaction on success only, and returns jsonb:
--   success {"ok":true,"user_id":...,"key_type"?:...,"replaced_key_id"?:...}
--   failure {"ok":false,"code":"not_found"|"stale"|"suspended"|"not_eligible"|"bad_reason"}   (a failure changes and audits nothing)
--   api_v2_approve_key(p_key, p_actor)           locks the slot's pending+active keys FOR NO KEY UPDATE ordered by id, then re-reads the
--                                                target in a fresh statement, then locks the owner's users row and any grant FOR SHARE.
--   api_v2_reject_key(p_key, p_actor, p_reason)  pending only; reason 3-200 characters after trimming.
--   api_v2_approve_access(p_request, p_actor)    pending only, owner not suspended; inserts the grant, closes the request, creates no key.
--   api_v2_reject_access(p_request, p_actor, p_reason)
--   api_v2_remove_grant(p_user, p_actor, p_reason)   deletes the grant; keys are not touched.
--   api_v2_approval_context(p_users uuid[])      {"<user>":{"topups_30d":numeric,"orders_30d":int}} for at most 200 users.
--   api_v2_new_request_code()                    the code helper (also service-role only).
-- Eligible = a grant exists OR users.role is in api_v2_config.allowed_roles. A grant never overrides a suspension.
-- Concurrency under READ COMMITTED: a row lock that waited re-checks the locked row against its WHERE clause and drops a row
-- that changed meanwhile; rows created after the statement snapshot are never seen. That is why every function re-reads the target
-- in a NEW statement after the locks are held, and why the replaced key is revoked with a separate UPDATE (fresh snapshot).
-- Row locks are FOR NO KEY UPDATE, never FOR UPDATE: every api_v2_logs insert takes a FOR KEY SHARE lock on its api_v2_keys row
-- (the key_id foreign key), which conflicts with FOR UPDATE but not with FOR NO KEY UPDATE, so approving a swap for a busy key
-- cannot starve behind, or stall, the request log. This is safe because no updated column belongs to a non-partial,
-- non-expression unique index or is referenced by a foreign key: api_v2_keys updates status, revoked_*, approved_*, rejected_*,
-- reject_reason, rate_limits, updated_at (unique keys are id, key_hash, request_code; the slot indexes are partial); the
-- request table updates status, decided_*, reason (unique keys are id, request_code; the pending index is partial).
--
-- LOCKS taken by this file (lock_timeout 2s bounds only the WAIT to acquire a lock, not how long it is held; every lock below
-- is held until the transaction ends, which for the dry run includes the whole self-test). Statements are ordered so the
-- locks on live tables are taken as late as possible: functions and the two new tables first, then the hot-table changes.
--   auth.users          SHARE ROW EXCLUSIVE (creating api_v2_access_requests / api_v2_access_grants, which reference it):
--                       blocks every auth.users write (sign-in, token and session refresh, signup) until the transaction ends.
--   api_v2_config       ACCESS EXCLUSIVE (ADD COLUMN): blocks every read of the config, so every API request, until the transaction
--                       ends. A queued ACCESS EXCLUSIVE request also stalls the readers that arrive behind it.
--   api_v2_logs         ACCESS EXCLUSIVE (ADD COLUMN): blocks every request-log insert until the transaction ends.
--   api_v2_keys         ACCESS EXCLUSIVE (ADD COLUMN, the unique index builds, DROP INDEX): blocks every key lookup and
--                       every key write until the transaction ends.
--   Everything else (new functions, the new tables themselves) takes no lock that touches live traffic.
-- Apply in a quiet window, with the dry run measured first.
-- A lock timeout (SQLSTATE 55P03) is harmless and safe to retry: nothing is applied, so just run it again. A statement timeout is the same.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.api_v2_access_requests'), to_regclass('public.api_v2_access_grants');   -- NULL, NULL
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_v2_keys'
--      AND column_name IN ('request_code','rejected_at','rejected_by','reject_reason');                 -- no rows
--   SELECT indexname FROM pg_indexes WHERE tablename = 'api_v2_keys' AND indexname LIKE 'api_v2_keys_one_%';   -- api_v2_keys_one_live_per_type only
--   SELECT key_type, environment, status, count(*) FROM public.api_v2_keys GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;   -- record the census
--   SELECT count(*) FROM public.api_v2_keys WHERE environment = 'live' AND status = 'pending';          -- record N = keys that receive a code
--   SELECT user_id, key_type, environment, count(*) FROM public.api_v2_keys WHERE status = 'active'
--      GROUP BY 1, 2, 3 HAVING count(*) > 1;                                                            -- no rows (the old index forbids it)
--   Top-up source census (api_v2_approval_context counts credits with source wallet_topup or momo_claim and status completed):
--   SELECT source, status, count(*) FROM public.transactions WHERE type = 'credit' GROUP BY 1, 2 ORDER BY 3 DESC;   -- record; confirm both sources exist and 'completed' is the settled status
--   Order tables read by api_v2_approval_context (the seven of admin_user_signals, 0174): orders, api_orders, hubtel_data_orders,
--   airtime_orders, hubtel_bill_orders, results_checker_orders, afa_orders (each needs user_id and created_at).
--   SELECT to_regclass('public.admin_audit_log');                                                       -- NOT NULL (0069 + 0176 applied)
--
-- VERIFY after applying:
--   SELECT has_table_privilege('anon','public.api_v2_access_requests','SELECT'), has_table_privilege('authenticated','public.api_v2_access_grants','SELECT');   -- false, false
--   SELECT has_function_privilege('authenticated','public.api_v2_approve_key(uuid,uuid)','EXECUTE'), has_function_privilege('service_role','public.api_v2_approve_key(uuid,uuid)','EXECUTE');   -- false, true
--   SELECT count(*) FROM public.api_v2_keys WHERE environment = 'live' AND status = 'pending' AND request_code IS NULL;   -- 0
--   SELECT indexname FROM pg_indexes WHERE tablename = 'api_v2_keys' AND indexname LIKE 'api_v2_keys_one_%' ORDER BY 1;   -- active_per_slot, pending_per_slot
--
-- Dry run: migrations/0194_api_approval.selftest.sql (build the run string by code, as lib/api-v2/migration-0194.test.ts does).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

-- ============ 1. functions (no table has to exist, so they come first and take no lock on live traffic) ============

-- code helper
CREATE OR REPLACE FUNCTION public.api_v2_new_request_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_alphabet CONSTANT text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; -- 31 characters
  v_bytes bytea;
  v_code text;
  v_i int;
  v_b int;
  v_tries int := 0;
BEGIN
  LOOP
    v_code := '';
    WHILE char_length(v_code) < 6 LOOP
      v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      FOR v_i IN 0..15 LOOP
        CONTINUE WHEN v_i IN (6, 8); -- version and variant bytes are not random
        v_b := get_byte(v_bytes, v_i);
        CONTINUE WHEN v_b >= 248;    -- 248 = 31 * 8: skip the biased tail
        v_code := v_code || substr(c_alphabet, (v_b % 31) + 1, 1);
        EXIT WHEN char_length(v_code) = 6;
      END LOOP;
    END LOOP;
    v_code := 'API-' || v_code;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.api_v2_keys WHERE request_code = v_code)
          AND NOT EXISTS (SELECT 1 FROM public.api_v2_access_requests WHERE request_code = v_code);
    v_tries := v_tries + 1;
    IF v_tries > 50 THEN
      RAISE EXCEPTION 'request code space exhausted';
    END IF;
  END LOOP;
  RETURN v_code;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_new_request_code() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_new_request_code() TO service_role;

-- approve a key
CREATE OR REPLACE FUNCTION public.api_v2_approve_key(p_key uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_user uuid;
  v_type text;
  v_env text;
  v_new record;
  v_old_id uuid;
  v_old_limits jsonb;
  v_limits jsonb;
  v_role text;
  v_susp boolean;
  v_has_user boolean;
  v_granted boolean;
  v_allowed text[];
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required';
  END IF;

  -- 1. Find the slot (plain read, no lock).
  SELECT k.user_id, k.key_type, k.environment INTO v_user, v_type, v_env
    FROM public.api_v2_keys k WHERE k.id = p_key;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  -- 2. Lock every pending/active key of the slot, ordered by id. A concurrent revoke or replace by the owner, or a second
  --    admin, holds one of these rows: we wait, and a row that changed meanwhile no longer matches and is skipped.
  --    FOR NO KEY UPDATE: does not conflict with the FOR KEY SHARE taken by api_v2_logs inserts.
  PERFORM 1 FROM public.api_v2_keys k
   WHERE k.user_id = v_user AND k.key_type = v_type AND k.environment = v_env AND k.status IN ('pending', 'active')
   ORDER BY k.id
   FOR NO KEY UPDATE;

  -- 3. Re-read the target in a NEW statement (fresh snapshot): its state is now final because we hold its lock, or it was
  --    not locked because it is no longer pending.
  SELECT * INTO v_new FROM public.api_v2_keys k WHERE k.id = p_key;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_new.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'stale');
  END IF;

  -- 4. Owner state, held with FOR SHARE so a suspension, role change or grant removal waits for this decision.
  SELECT u.role, coalesce(u.is_suspended, false) INTO v_role, v_susp
    FROM public.users u WHERE u.id = v_user FOR SHARE;
  v_has_user := FOUND;
  PERFORM 1 FROM public.api_v2_access_grants g WHERE g.user_id = v_user FOR SHARE;
  v_granted := FOUND;
  SELECT c.allowed_roles INTO v_allowed FROM public.api_v2_config c WHERE c.id;

  IF v_has_user AND v_susp THEN
    RETURN jsonb_build_object('ok', false, 'code', 'suspended');
  END IF;
  IF NOT (v_granted OR (v_has_user AND coalesce(v_role = ANY (coalesce(v_allowed, '{}'::text[])), false))) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_eligible');
  END IF;

  -- 5. Revoke the active key (if the owner did not already), then activate the new one. The old key is revoked only here,
  --    in the same transaction that activates the new one.
  UPDATE public.api_v2_keys k
     SET status = 'revoked', revoked_at = now(), revoked_by = p_actor, updated_at = now()
   WHERE k.user_id = v_user AND k.key_type = v_type AND k.environment = v_env AND k.status = 'active' AND k.id <> p_key
  RETURNING k.id, k.rate_limits INTO v_old_id, v_old_limits;

  v_limits := CASE
    WHEN v_new.rate_limits IS NULL OR v_new.rate_limits = '{}'::jsonb THEN coalesce(v_old_limits, v_new.rate_limits)
    ELSE v_new.rate_limits
  END;

  UPDATE public.api_v2_keys k
     SET status = 'active', approved_at = now(), approved_by = p_actor, rate_limits = v_limits, updated_at = now()
   WHERE k.id = p_key;

  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor, 'api_key_approve', v_user,
          jsonb_build_object('status', 'pending', 'replaced_key_id', v_old_id),
          jsonb_build_object('status', 'active', 'key_id', p_key, 'key_type', v_type, 'environment', v_env,
                             'replaced_key_id', v_old_id, 'request_code', v_new.request_code));

  RETURN jsonb_build_object('ok', true, 'user_id', v_user, 'key_type', v_type, 'replaced_key_id', v_old_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_approve_key(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_approve_key(uuid, uuid) TO service_role;

-- reject a key
CREATE OR REPLACE FUNCTION public.api_v2_reject_key(p_key uuid, p_actor uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_reason text := btrim(coalesce(p_reason, ''));
  v_k record;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_reason');
  END IF;

  -- One row, no status filter in the lock: after a wait the current committed version is returned.
  SELECT * INTO v_k FROM public.api_v2_keys k WHERE k.id = p_key FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_k.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'stale');
  END IF;

  UPDATE public.api_v2_keys k
     SET status = 'revoked', revoked_at = now(), revoked_by = p_actor,
         rejected_at = now(), rejected_by = p_actor, reject_reason = v_reason, updated_at = now()
   WHERE k.id = p_key;

  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor, 'api_key_reject', v_k.user_id,
          jsonb_build_object('status', 'pending'),
          jsonb_build_object('status', 'revoked', 'key_id', p_key, 'key_type', v_k.key_type,
                             'environment', v_k.environment, 'request_code', v_k.request_code, 'reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'user_id', v_k.user_id, 'key_type', v_k.key_type);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_reject_key(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_reject_key(uuid, uuid, text) TO service_role;

-- approve access
CREATE OR REPLACE FUNCTION public.api_v2_approve_access(p_request uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_req record;
  v_susp boolean;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required';
  END IF;

  SELECT * INTO v_req FROM public.api_v2_access_requests r WHERE r.id = p_request FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'stale');
  END IF;

  SELECT coalesce(u.is_suspended, false) INTO v_susp FROM public.users u WHERE u.id = v_req.user_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_susp THEN
    RETURN jsonb_build_object('ok', false, 'code', 'suspended');
  END IF;

  INSERT INTO public.api_v2_access_grants (user_id, granted_by, request_id)
  VALUES (v_req.user_id, p_actor, p_request)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.api_v2_access_requests r
     SET status = 'approved', decided_at = now(), decided_by = p_actor
   WHERE r.id = p_request;

  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor, 'api_access_approve', v_req.user_id,
          jsonb_build_object('status', 'pending'),
          jsonb_build_object('status', 'approved', 'request_id', p_request, 'request_code', v_req.request_code));

  RETURN jsonb_build_object('ok', true, 'user_id', v_req.user_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_approve_access(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_approve_access(uuid, uuid) TO service_role;

-- reject access
CREATE OR REPLACE FUNCTION public.api_v2_reject_access(p_request uuid, p_actor uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_reason text := btrim(coalesce(p_reason, ''));
  v_req record;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_reason');
  END IF;

  SELECT * INTO v_req FROM public.api_v2_access_requests r WHERE r.id = p_request FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'stale');
  END IF;

  UPDATE public.api_v2_access_requests r
     SET status = 'rejected', decided_at = now(), decided_by = p_actor, reason = v_reason
   WHERE r.id = p_request;

  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor, 'api_access_reject', v_req.user_id,
          jsonb_build_object('status', 'pending'),
          jsonb_build_object('status', 'rejected', 'request_id', p_request, 'request_code', v_req.request_code, 'reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'user_id', v_req.user_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_reject_access(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_reject_access(uuid, uuid, text) TO service_role;

-- remove a grant
CREATE OR REPLACE FUNCTION public.api_v2_remove_grant(p_user uuid, p_actor uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_reason text := btrim(coalesce(p_reason, ''));
  v_granted_by uuid;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_reason');
  END IF;

  DELETE FROM public.api_v2_access_grants g WHERE g.user_id = p_user RETURNING g.granted_by INTO v_granted_by;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
  VALUES (p_actor, 'api_grant_remove', p_user,
          jsonb_build_object('granted_by', v_granted_by),
          jsonb_build_object('reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'user_id', p_user);
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_remove_grant(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_remove_grant(uuid, uuid, text) TO service_role;

-- approval context (read only)
CREATE OR REPLACE FUNCTION public.api_v2_approval_context(p_users uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_cap CONSTANT int := 10000; -- per order table, keeps one huge account from making the read slow
  v_ids uuid[];
  v_since timestamptz := now() - interval '30 days';
  v_result jsonb;
BEGIN
  IF p_users IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_users) AS x WHERE x IS NOT NULL;
  IF v_ids IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION 'at most 200 user ids';
  END IF;

  SELECT coalesce(jsonb_object_agg(i.id::text, jsonb_build_object(
    'topups_30d', coalesce((SELECT sum(t.amount) FROM public.transactions t
                             WHERE t.user_id = i.id AND t.type = 'credit' AND t.source IN ('wallet_topup', 'momo_claim')
                               AND t.status = 'completed' AND t.created_at >= v_since), 0)::numeric,
    'orders_30d',
      (SELECT count(*) FROM (SELECT 1 FROM public.orders o WHERE o.user_id = i.id AND o.created_at >= v_since LIMIT c_cap) x)
    + (SELECT count(*) FROM (SELECT 1 FROM public.api_orders ao WHERE ao.user_id = i.id AND ao.created_at >= v_since LIMIT c_cap) x)
    + (SELECT count(*) FROM (SELECT 1 FROM public.hubtel_data_orders hd WHERE hd.user_id = i.id AND hd.created_at >= v_since LIMIT c_cap) x)
    + (SELECT count(*) FROM (SELECT 1 FROM public.airtime_orders air WHERE air.user_id = i.id AND air.created_at >= v_since LIMIT c_cap) x)
    + (SELECT count(*) FROM (SELECT 1 FROM public.hubtel_bill_orders hb WHERE hb.user_id = i.id AND hb.created_at >= v_since LIMIT c_cap) x)
    + (SELECT count(*) FROM (SELECT 1 FROM public.results_checker_orders rc WHERE rc.user_id = i.id AND rc.created_at >= v_since LIMIT c_cap) x)
    + (SELECT count(*) FROM (SELECT 1 FROM public.afa_orders afa WHERE afa.user_id = i.id AND afa.created_at >= v_since LIMIT c_cap) x)
  )), '{}'::jsonb)
  INTO v_result
  FROM unnest(v_ids) AS i(id);

  RETURN v_result;
END;
$fn$;
REVOKE ALL ON FUNCTION public.api_v2_approval_context(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v2_approval_context(uuid[]) TO service_role;

-- ============ 2. new tables (their foreign keys take SHARE ROW EXCLUSIVE on auth.users until the transaction ends) ============
CREATE TABLE IF NOT EXISTS public.api_v2_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS api_v2_access_requests_one_pending_per_user
  ON public.api_v2_access_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS api_v2_access_requests_status_idx ON public.api_v2_access_requests (status, created_at);

CREATE TABLE IF NOT EXISTS public.api_v2_access_grants (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid REFERENCES public.api_v2_access_requests(id) ON DELETE SET NULL
);

-- service_role only: RLS on, no policies, every client privilege revoked (0060 grants authenticated CRUD by default).
ALTER TABLE public.api_v2_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_access_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_v2_access_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.api_v2_access_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_v2_access_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_v2_access_grants TO service_role;

-- ============ 3. hot tables, last: each ACCESS EXCLUSIVE lock below is held to the end of the transaction ============
ALTER TABLE public.api_v2_config ADD COLUMN IF NOT EXISTS approval_whatsapp text;
ALTER TABLE public.api_v2_logs ADD COLUMN IF NOT EXISTS error_reason text;

ALTER TABLE public.api_v2_keys ADD COLUMN IF NOT EXISTS request_code text;
ALTER TABLE public.api_v2_keys ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE public.api_v2_keys ADD COLUMN IF NOT EXISTS rejected_by uuid;
ALTER TABLE public.api_v2_keys ADD COLUMN IF NOT EXISTS reject_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS api_v2_keys_request_code_key ON public.api_v2_keys (request_code);

-- both new slot indexes first (an active key and a pending replacement may coexist), the old index is dropped last
CREATE UNIQUE INDEX IF NOT EXISTS api_v2_keys_one_active_per_slot
  ON public.api_v2_keys (user_id, key_type, environment) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS api_v2_keys_one_pending_per_slot
  ON public.api_v2_keys (user_id, key_type, environment) WHERE status = 'pending';

-- backfill: pending live keys get a code
DO $fn$
DECLARE
  r record;
  v_tries int;
BEGIN
  FOR r IN SELECT id FROM public.api_v2_keys
            WHERE environment = 'live' AND status = 'pending' AND request_code IS NULL
            ORDER BY created_at, id LOOP
    v_tries := 0;
    LOOP
      BEGIN
        UPDATE public.api_v2_keys SET request_code = public.api_v2_new_request_code()
         WHERE id = r.id AND request_code IS NULL;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_tries := v_tries + 1;
        IF v_tries > 20 THEN
          RAISE;
        END IF;
      END;
    END LOOP;
  END LOOP;
END
$fn$;

DROP INDEX IF EXISTS public.api_v2_keys_one_live_per_type;

COMMIT;
