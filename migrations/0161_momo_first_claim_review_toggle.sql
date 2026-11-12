-- 0161_momo_first_claim_review_toggle.sql
--
-- Send & Claim: admin toggle "Review each customer's first claim" (admin_settings key momo_first_claim_review).
-- 0160 (applied in production, never edited) flags every user's first claim 'first_claim' for review. This migration:
--   1. seeds momo_first_claim_review = {"value": true} (ON CONFLICT DO NOTHING: today's behaviour, never overwrites);
--   2. replaces public.claim_momo_transaction with 0160's body, signature, SECURITY DEFINER and search_path, changing ONE
--      thing: the first_claim reason is added only while the setting is on. "On" means anything but an exact JSON false
--      in value->'value': a missing row, a malformed value, a string "false", 0 or null all keep review ON (fail safe).
--      The setting is read under the wallet lock, with the other per-user checks.
--   Every other check is unchanged: above_review_threshold, daily_cap, amount_mismatch (webhook), too_many_attempts and
--   the rate limits (claim_momo_via_session, not touched), and the SMS intake flags (app code).
--   3. re-states EXECUTE: nobody (PUBLIC, anon, authenticated, service_role) may call the internal function. CREATE OR
--      REPLACE keeps the ACL; this is explicit.
-- One transaction. Idempotent (re-runnable). NOT applied by the implementing agent.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), p.prosecdef, p.proconfig
--     FROM pg_proc p WHERE p.oid = 'public.claim_momo_transaction(text,uuid,uuid,boolean,text)'::regprocedure;
--     -- p_txid text, p_user uuid, p_session_id uuid, p_check_amount boolean, p_mode text | text | true | {search_path=""}
--   SELECT count(*) FROM pg_proc WHERE proname = 'claim_momo_transaction';                       -- 1 (no overload)
--   SELECT pg_get_userbyid(proowner) FROM pg_proc
--    WHERE oid = 'public.claim_momo_transaction(text,uuid,uuid,boolean,text)'::regprocedure;   -- the applying role (postgres)
--   SELECT md5(btrim(replace(prosrc, E'\r', ''), E'\n')) FROM pg_proc
--    WHERE oid = 'public.claim_momo_transaction(text,uuid,uuid,boolean,text)'::regprocedure;
--     -- must equal fdee23191c27ae1df91aa6d8263867a0 (md5 of the committed 0160 body; lib/momo-claim/migration-0161.test.ts
--     --  recomputes it from the 0160 file and from 0160 applied in PGlite, so this constant cannot drift)
--   SELECT strpos(p.prosrc, 'ARRAY[''first_claim'']') > 0, strpos(p.prosrc, 'momo_first_claim_review') = 0
--     FROM pg_proc p WHERE p.oid = 'public.claim_momo_transaction(text,uuid,uuid,boolean,text)'::regprocedure;   -- true, true
--   SELECT count(*) FROM admin_settings WHERE key = 'momo_first_claim_review';   -- 0
--   SELECT has_function_privilege('service_role', 'public.claim_momo_transaction(text,uuid,uuid,boolean,text)', 'EXECUTE');   -- false
--
-- Self-test (self-rolling-back dry run): migrations/0161_momo_first_claim_review_toggle.selftest.sql
-- The run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement
-- (the 0130 incident lesson); lib/momo-claim/migration-0161.test.ts builds and checks it.
--
-- ROLLBACK (if ever needed): re-run 0160's section 7e (CREATE OR REPLACE FUNCTION public.claim_momo_transaction ...) and
-- its REVOKE line for that function. The setting row may stay: nothing else reads it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. The setting. Default on: today's behaviour.
INSERT INTO public.admin_settings (key, value, description) VALUES
  ('momo_first_claim_review', '{"value": true}'::jsonb, 'Send & Claim: review each customer''s first claim. Off: a first claim is credited automatically; large amounts and daily limits are still reviewed.')
ON CONFLICT (key) DO NOTHING;

-- 2. The shared claim (0160 section 7e), first_claim gated on the setting. Internal: only the two wrappers call it.
--    Returns credited | under_review | already_credited | not_matched.
CREATE OR REPLACE FUNCTION public.claim_momo_transaction(
  p_txid         text,
  p_user         uuid,
  p_session_id   uuid,
  p_check_amount boolean,
  p_mode         text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_sess    public.wallet_topup_sessions%ROWTYPE;
  v_tx      public.momo_transactions%ROWTYPE;
  v_fee     numeric;
  v_net     numeric;
  v_today   numeric;
  v_reasons text[] := ARRAY[]::text[];
  v_res     text;
  v_review  boolean;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('webhook', 'manual') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'mode must be webhook or manual';
  END IF;
  IF p_txid IS NULL OR p_user IS NULL OR p_session_id IS NULL OR p_check_amount IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'txid, user, session and amount check required';
  END IF;

  -- 1. The session (the caller holds its lock; taking it again is a no-op and keeps the order if a caller forgets).
  SELECT * INTO v_sess FROM public.wallet_topup_sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_sess.user_id IS DISTINCT FROM p_user OR v_sess.status <> 'pending' OR v_sess.expires_at <= now() THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'session is not open for this user';
  END IF;

  -- 2. The momo row, locked. Only a pending row may move on.
  SELECT * INTO v_tx FROM public.momo_transactions m WHERE m.transaction_id = p_txid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_matched';
  END IF;
  IF v_tx.status = 'claimed' AND v_tx.claimed_by = p_user THEN
    RETURN 'already_credited';
  END IF;
  IF v_tx.status <> 'pending' OR v_tx.received_at < v_sess.created_at THEN
    RETURN 'not_matched';
  END IF;

  -- 3. Amount, exact to the pesewa.
  IF v_tx.amount IS NULL OR (p_check_amount AND v_tx.amount <> v_sess.amount) THEN
    IF p_mode = 'webhook' AND v_tx.amount IS NOT NULL THEN
      UPDATE public.momo_transactions m
         SET status = 'flagged', flag_reasons = m.flag_reasons || ARRAY['amount_mismatch'], session_id = p_session_id, claimed_by = NULL
       WHERE m.id = v_tx.id;
      RETURN 'under_review';
    END IF;
    RETURN 'not_matched';
  END IF;

  -- 4. The session's quote (what the customer was shown), never recomputed here. It must add up.
  v_fee := v_sess.fee;
  v_net := v_sess.net_amount;
  IF v_fee IS NULL OR v_net IS NULL OR v_fee < 0 OR NOT (v_net > 0) OR v_fee + v_net <> v_sess.amount OR v_sess.amount <> v_tx.amount THEN
    RAISE EXCEPTION 'BAD_STATE' USING DETAIL = 'the session quote does not add up';
  END IF;

  -- 5. Lock the wallet BEFORE the per-user checks, so concurrent claims for one user (webhook and claim box) read the
  --    day's total one at a time. Lock order stays session -> row -> wallet. No wallet: the whole call rolls back.
  PERFORM 1 FROM public.wallets w WHERE w.user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_WALLET';
  END IF;

  -- 6. Per-user checks, under the wallet lock. first_claim only while momo_first_claim_review is on: anything but an exact
  --    JSON false (missing row, malformed value) keeps it on.
  v_review := (SELECT s.value -> 'value' FROM public.admin_settings s WHERE s.key = 'momo_first_claim_review') IS DISTINCT FROM 'false'::jsonb;
  IF v_review AND NOT EXISTS (SELECT 1 FROM public.momo_transactions m WHERE m.claimed_by = p_user AND m.status = 'claimed') THEN
    v_reasons := v_reasons || ARRAY['first_claim'];
  END IF;
  IF v_net > public.momo_setting_numeric('momo_auto_claim_review_threshold', 500) THEN
    v_reasons := v_reasons || ARRAY['above_review_threshold'];
  END IF;
  SELECT COALESCE(sum(m.net_amount), 0) INTO v_today
    FROM public.momo_transactions m
   WHERE m.claimed_by = p_user AND m.status = 'claimed'
     AND m.claimed_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
  IF v_today + v_net > public.momo_setting_numeric('momo_auto_claim_daily_cap', 3000) THEN
    v_reasons := v_reasons || ARRAY['daily_cap'];
  END IF;
  IF cardinality(v_reasons) > 0 THEN
    UPDATE public.momo_transactions m
       SET status = 'flagged', flag_reasons = m.flag_reasons || v_reasons, session_id = p_session_id, claimed_by = NULL
     WHERE m.id = v_tx.id;
    RETURN 'under_review';
  END IF;

  -- 7. Credit (the wallet lock is already held; momo_credit_wallet takes it again, a no-op), then close the row and session.
  v_res := public.momo_credit_wallet(p_txid, p_user, v_net);
  IF v_res <> 'credited' THEN
    RETURN v_res;
  END IF;
  UPDATE public.momo_transactions m
     SET status = 'claimed', claimed_by = p_user, claimed_at = now(), fee = v_fee, net_amount = v_net, session_id = p_session_id
   WHERE m.id = v_tx.id;
  UPDATE public.wallet_topup_sessions s
     SET status = 'claimed', claimed_transaction_id = p_txid
   WHERE s.id = p_session_id;
  RETURN 'credited';
END
$fn$;

-- 3. EXECUTE: internal, nobody (the definer wrappers run as the owner).
REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(text, uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT value FROM admin_settings WHERE key = 'momo_first_claim_review';   -- {"value": true}
--   SELECT strpos(prosrc, 'momo_first_claim_review') > 0 FROM pg_proc
--    WHERE oid = 'public.claim_momo_transaction(text,uuid,uuid,boolean,text)'::regprocedure;   -- true
--   SELECT r, has_function_privilege(r, 'public.claim_momo_transaction(text,uuid,uuid,boolean,text)', 'EXECUTE')
--     FROM unnest(ARRAY['anon','authenticated','service_role']) r;   -- all false
