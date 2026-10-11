-- Phase 3b / Task 13 review fixes. Apply AFTER 20261013_sms_policy_enforcement.sql and BEFORE
-- sms_policy_enforced is ever set to true. No-op for today's traffic (the lease is only used by
-- enforced sends).

BEGIN;

-- ── Per-account send lease (lib/sms/enforcement.ts trySendLock / releaseSendLock) ─────────────
-- Usage (sms_account_usage) counts a send only once its log row exists, so parallel enforced
-- sends would all read the same usage and pass the caps together. An enforced send takes this
-- lease before reading usage and releases it after its last log row is written.
-- The lease is OWNED: acquiring returns a fresh token, and only that token can release it, so a
-- send that outlived its lease can never clear a lease another send has since taken.
ALTER TABLE sms_accounts
  ADD COLUMN IF NOT EXISTS send_lock_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS send_lock_owner UUID;

-- Signatures/return types changed while this file was unapplied; drop any earlier shape.
DROP FUNCTION IF EXISTS sms_try_send_lock(UUID, INT);
DROP FUNCTION IF EXISTS sms_release_send_lock(UUID);
DROP FUNCTION IF EXISTS sms_release_send_lock(UUID, UUID);

-- Single atomic conditional UPDATE ... RETURNING: a fresh owner token for the caller that set
-- the lease, NULL when another unexpired lease exists (busy).
CREATE OR REPLACE FUNCTION sms_try_send_lock(p_account_id UUID, p_seconds INT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token UUID := gen_random_uuid();
  v_owner UUID;
BEGIN
  IF p_seconds IS NULL OR p_seconds < 1 OR p_seconds > 900 THEN
    RAISE EXCEPTION 'INVALID_SECONDS' USING ERRCODE = 'P0001';
  END IF;
  UPDATE sms_accounts
  SET send_lock_until = now() + make_interval(secs => p_seconds),
      send_lock_owner = v_token
  WHERE id = p_account_id
    AND (send_lock_until IS NULL OR send_lock_until < now())
  RETURNING send_lock_owner INTO v_owner;
  RETURN v_owner; -- NULL when busy (no row updated)
END;
$$;

-- Clears the lease only for its current owner.
CREATE OR REPLACE FUNCTION sms_release_send_lock(p_account_id UUID, p_token UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE sms_accounts SET send_lock_until = NULL, send_lock_owner = NULL
  WHERE id = p_account_id AND send_lock_owner = p_token;
$$;

REVOKE ALL ON FUNCTION sms_try_send_lock(UUID, INT)           FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_try_send_lock(UUID, INT)       TO service_role;
REVOKE ALL ON FUNCTION sms_release_send_lock(UUID, UUID)      FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_release_send_lock(UUID, UUID)  TO service_role;

-- ── Hide policy_shadow / flag_reason from browser roles ───────────────────────────────────────
-- 0060 grants authenticated table-wide SELECT and 0067's owner RLS policy lets a customer read
-- their own sms_send_logs rows through PostgREST with their own JWT — including policy_shadow
-- (matched keywords, flag details) and flag_reason. No app/client code reads this table with a
-- browser key (all reads are service_role API routes), so restrict those two columns.
-- A column-level REVOKE cannot carve columns out of a table-level grant, so: revoke table-level
-- SELECT, then grant SELECT back on every OTHER column. service_role is untouched.
-- Guard: abort if the table's columns differ from what this list was built from (0067 +
-- 20261010_sms_platform_foundation), so no unknown column is silently hidden or exposed.
DO $$
DECLARE
  v_expected TEXT[] := ARRAY[
    'id','sms_account_id','message','sender_id','recipients_count','segments','credits_reserved',
    'credits_used','status','flagged','flag_reason','provider','created_at','completed_at',
    'mode','policy_shadow','provider_batch_id'];
  v_actual TEXT[];
BEGIN
  SELECT array_agg(column_name::text ORDER BY column_name) INTO v_actual
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sms_send_logs';
  IF v_actual IS DISTINCT FROM (SELECT array_agg(c ORDER BY c) FROM unnest(v_expected) c) THEN
    RAISE EXCEPTION 'sms_send_logs columns differ from expected list: %', v_actual;
  END IF;
END $$;

REVOKE SELECT ON sms_send_logs FROM anon, authenticated;
GRANT SELECT (
  id, sms_account_id, message, sender_id, recipients_count, segments, credits_reserved,
  credits_used, status, flagged, provider, created_at, completed_at, mode, provider_batch_id
) ON sms_send_logs TO authenticated;

DO $$
BEGIN
  IF has_column_privilege('authenticated', 'public.sms_send_logs', 'policy_shadow', 'SELECT')
     OR has_column_privilege('authenticated', 'public.sms_send_logs', 'flag_reason', 'SELECT') THEN
    RAISE EXCEPTION 'invariant: authenticated can still read policy_shadow/flag_reason';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.sms_send_logs', 'status', 'SELECT') THEN
    RAISE EXCEPTION 'invariant: authenticated lost SELECT on the other columns';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sms_send_logs', 'SELECT') THEN
    RAISE EXCEPTION 'invariant: service_role lost SELECT on sms_send_logs';
  END IF;
END $$;

COMMIT;
