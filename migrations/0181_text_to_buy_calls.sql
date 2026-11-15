-- 0181_text_to_buy_calls.sql
--
-- Text-to-Buy, missed-call support SMS: the call log. ADDITIVE; service-role only. NOT applied by the implementing agent.
-- One transaction. Idempotent (re-runnable). Needs 0177 (ttb_ tables) and 0180 (the current ttb_purge). Ships dark: nothing
-- reads or writes the table until later tasks of the plan.
--
--   ttb_calls    one row per missed call the support SMS handled or skipped: which line was rung, the caller (local 0XXXXXXXXX),
--                the shop (shop line only, else NULL) and the outcome. Used for the hourly reply cap and the admin day counts.
--                service_role may only SELECT and INSERT; rows are removed by ttb_purge.
--   ttb_purge    replaced (same signature, SECURITY DEFINER, search_path, grants as 0180): every 0180 delete kept as is, plus
--                calls older than the cut-off.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.ttb_calls');                                                              -- NULL
--   SELECT to_regclass('public.ttb_messages'), to_regclass('public.ttb_shop_prefs');                    -- both NOT NULL (0177, 0180)
--   SELECT count(*) FROM pg_proc WHERE proname = 'ttb_purge';                                            -- 1
--
-- Self-test (self-rolling-back dry run): migrations/0181_text_to_buy_calls.selftest.sql
-- The run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement
-- (the 0130 incident lesson); lib/text-to-buy/migration-0181.test.ts builds and checks it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. The call log.
CREATE TABLE IF NOT EXISTS public.ttb_calls (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line       text NOT NULL CHECK (line IN ('main', 'shop')),
  sender     text NOT NULL,                                                         -- local 0XXXXXXXXX
  shop_id    uuid,
  outcome    text NOT NULL CHECK (outcome IN ('replied_main', 'replied_shop', 'replied_support', 'skipped_duplicate', 'skipped_cap',
                                              'skipped_off', 'skipped_invalid', 'skipped_blocked', 'skipped_stale', 'error')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ttb_calls_line_created_idx ON public.ttb_calls (line, created_at);

-- 2. Lock it down. No policies on purpose; 0060 grants authenticated CRUD by default, the REVOKE keeps it out.
ALTER TABLE public.ttb_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ttb_calls FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.ttb_calls TO service_role;

-- 3. ttb_purge, replaced again: the 0180 definition unchanged, plus old calls.
CREATE OR REPLACE FUNCTION public.ttb_purge(p_before timestamptz)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_msgs int;
  v_convs int;
  v_notices int;
  v_reserves int;
  v_prefs int;
  v_calls int;
BEGIN
  DELETE FROM public.ttb_messages m WHERE m.created_at < p_before;
  GET DIAGNOSTICS v_msgs = ROW_COUNT;
  DELETE FROM public.ttb_conversations c WHERE c.expires_at < p_before;
  GET DIAGNOSTICS v_convs = ROW_COUNT;
  DELETE FROM public.ttb_notices n WHERE n.created_at < p_before;
  GET DIAGNOSTICS v_notices = ROW_COUNT;
  -- Only RELEASED reserves: an unreleased one still owes the shop a refund of held - used.
  DELETE FROM public.ttb_credit_reserves r WHERE r.released_at IS NOT NULL AND r.created_at < p_before;
  GET DIAGNOSTICS v_reserves = ROW_COUNT;
  DELETE FROM public.ttb_shop_prefs p WHERE p.last_used_at < p_before;
  GET DIAGNOSTICS v_prefs = ROW_COUNT;
  DELETE FROM public.ttb_calls k WHERE k.created_at < p_before;
  GET DIAGNOSTICS v_calls = ROW_COUNT;
  RETURN v_msgs + v_convs + v_notices + v_reserves + v_prefs + v_calls;
END
$fn$;

-- 4. EXECUTE: service_role only. (CREATE OR REPLACE kept the grants; re-stated so a rerun is explicit.)
REVOKE ALL ON FUNCTION public.ttb_purge(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ttb_purge(timestamptz) TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.ttb_calls'::regclass;          -- 1 row, true
--   SELECT count(*) FROM pg_policies WHERE tablename = 'ttb_calls';                                          -- 0
--   SELECT has_table_privilege('anon', 'public.ttb_calls', 'SELECT'), has_table_privilege('authenticated', 'public.ttb_calls', 'SELECT'),
--          has_table_privilege('service_role', 'public.ttb_calls', 'INSERT');                                -- false, false, true
--   SELECT has_function_privilege('anon', 'public.ttb_purge(timestamptz)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.ttb_purge(timestamptz)', 'EXECUTE');               -- false, true
