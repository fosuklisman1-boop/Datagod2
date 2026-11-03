-- 0149_sub_agent_price_reminders.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0149_sub_agent_price_reminders.sql. Send this whole file as one
-- run: it opens a transaction, applies the migration statements (copied verbatim from 0149), then a DO block that
-- always RAISEs, which aborts the transaction so the column, constraint, index, function change, the test-only
-- grant and every test write are rolled back. It never ends the transaction itself, and the DO body closes only
-- with its labelled terminator. Before sending, assert by code that the run string contains no
-- transaction-ending statement. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other
-- error means it failed. If the client keeps the session open, send `ROLLBACK;`. After the real apply, the DO
-- block alone can be run inside `BEGIN; ...` the same way (existing_rows_zero then needs no reminders sent yet).
--
-- Scenarios (labels): column (smallint, not null, default 0), existing_rows_zero, index (partial predicate),
-- check_catalog, claim (a conditional UPDATE on the old value wins once, a stale one updates nothing), then a
-- test-only `GRANT UPDATE ON public.user_shops TO authenticated` (as in the 0148 selftest; rolled back, never
-- persists) so the trigger itself is tested: owner_blocked (price_reminders_sent and created_at refused with the
-- trigger's exact message), owner_allowed (an unprotected column is still editable), then as service_role:
-- check_violation (4 and -1 refused by the CHECK), service_unaffected (a valid value is accepted).
--
-- Needs at least one existing user_shops row with a user_id (the owner). "Owner" is simulated with
-- SET LOCAL ROLE authenticated plus request.jwt.claims, as in the 0148 selftest.

BEGIN;

ALTER TABLE public.user_shops ADD COLUMN IF NOT EXISTS price_reminders_sent smallint NOT NULL DEFAULT 0;

ALTER TABLE public.user_shops DROP CONSTRAINT IF EXISTS user_shops_price_reminders_sent_range;
ALTER TABLE public.user_shops
  ADD CONSTRAINT user_shops_price_reminders_sent_range CHECK (price_reminders_sent BETWEEN 0 AND 3);

CREATE INDEX IF NOT EXISTS user_shops_price_reminder_scan_idx
  ON public.user_shops (price_reminders_sent, created_at)
  WHERE joined_via = 'storefront' AND prices_set_at IS NULL;

CREATE OR REPLACE FUNCTION public.user_shops_protect_join_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF auth.role() IN ('authenticated', 'anon') AND (
       NEW.is_active IS DISTINCT FROM OLD.is_active
    OR NEW.joined_via IS DISTINCT FROM OLD.joined_via
    OR NEW.prices_set_at IS DISTINCT FROM OLD.prices_set_at
    OR NEW.dealer_rates_enabled IS DISTINCT FROM OLD.dealer_rates_enabled
    OR NEW.sub_agent_setup_alert_at IS DISTINCT FROM OLD.sub_agent_setup_alert_at
    OR NEW.sub_agent_prices_ready_notified_at IS DISTINCT FROM OLD.sub_agent_prices_ready_notified_at
    OR NEW.is_blocked IS DISTINCT FROM OLD.is_blocked
    OR NEW.block_reason IS DISTINCT FROM OLD.block_reason
    OR NEW.parent_shop_id IS DISTINCT FROM OLD.parent_shop_id
    OR NEW.tier_level IS DISTINCT FROM OLD.tier_level
    OR NEW.price_reminders_sent IS DISTINCT FROM OLD.price_reminders_sent
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'protected shop columns cannot be changed by the shop owner'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

DO $selftest$
DECLARE
  v_n     int;
  v_def   text;
  v_pred  text;
  v_shop  uuid;
  v_owner uuid;
  v_got   text;
  v_seen  text;
  v_col   text;
  v_val   int;
BEGIN
  -- Setup -------------------------------------------------------------------
  SELECT s.id, s.user_id INTO v_shop, v_owner
    FROM public.user_shops s
   WHERE s.user_id IS NOT NULL AND s.price_reminders_sent = 0
   ORDER BY s.id
   LIMIT 1;
  IF v_shop IS NULL THEN RAISE EXCEPTION 'FAIL setup: no user_shops row with an owner'; END IF;

  -- column ------------------------------------------------------------------
  SELECT count(*), max(column_default) INTO v_n, v_def FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'user_shops' AND column_name = 'price_reminders_sent'
     AND data_type = 'smallint' AND is_nullable = 'NO';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL column: price_reminders_sent smallint not null found %', v_n; END IF;
  IF v_def IS NULL OR v_def NOT LIKE '0%' THEN RAISE EXCEPTION 'FAIL column: default is %', v_def; END IF;

  -- existing_rows_zero ------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.user_shops WHERE price_reminders_sent IS DISTINCT FROM 0;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL existing_rows_zero: % rows not 0', v_n; END IF;

  -- index -------------------------------------------------------------------
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO v_pred
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'user_shops_price_reminder_scan_idx' AND i.indrelid = 'public.user_shops'::regclass;
  IF v_pred IS NULL THEN RAISE EXCEPTION 'FAIL index: missing or not partial'; END IF;
  IF v_pred NOT LIKE '%joined_via%storefront%' OR v_pred NOT LIKE '%prices_set_at IS NULL%' THEN
    RAISE EXCEPTION 'FAIL index: predicate is %', v_pred;
  END IF;

  -- check_catalog -----------------------------------------------------------
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.user_shops'::regclass AND conname = 'user_shops_price_reminders_sent_range'
     AND contype = 'c';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL check_catalog: constraint found %', v_n; END IF;

  -- claim (no jwt: auth.role() is not authenticated/anon) --------------------
  UPDATE public.user_shops SET price_reminders_sent = 2 WHERE id = v_shop AND price_reminders_sent = 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL claim: first claim updated % rows', v_n; END IF;
  UPDATE public.user_shops SET price_reminders_sent = 2 WHERE id = v_shop AND price_reminders_sent = 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL claim: stale claim updated % rows', v_n; END IF;

  -- Simulate the shop owner (authenticated, own jwt). ------------------------
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  -- TEST-ONLY GRANT. Production gives authenticated only SELECT on user_shops, so an owner never reaches the
  -- trigger there. Grant UPDATE here to prove the trigger itself (the second layer). The whole transaction
  -- aborts at the final RAISE, so the grant NEVER persists. Never run this outside the rolled-back transaction.
  GRANT UPDATE ON public.user_shops TO authenticated;

  -- owner_blocked -----------------------------------------------------------
  FOREACH v_col IN ARRAY ARRAY['price_reminders_sent_reset', 'price_reminders_sent_negative', 'created_at'] LOOP
    v_got := NULL; v_seen := NULL;
    <<owner_blocked>>
    BEGIN
      SET LOCAL ROLE authenticated;
      v_seen := current_user;
      IF v_col = 'price_reminders_sent_reset' THEN
        UPDATE public.user_shops SET price_reminders_sent = 0 WHERE id = v_shop;
      ELSIF v_col = 'price_reminders_sent_negative' THEN
        UPDATE public.user_shops SET price_reminders_sent = -1 WHERE id = v_shop;
      ELSE
        UPDATE public.user_shops SET created_at = created_at - interval '1 day' WHERE id = v_shop;
      END IF;
      v_got := 'NO_ERROR';
    EXCEPTION WHEN OTHERS THEN
      v_got := SQLERRM;
    END owner_blocked;
    RESET ROLE;
    IF v_seen IS DISTINCT FROM 'authenticated' THEN
      RAISE EXCEPTION 'FAIL owner_blocked %: could not switch role (current_user %, err %)', v_col, v_seen, v_got;
    END IF;
    IF v_got IS DISTINCT FROM 'protected shop columns cannot be changed by the shop owner' THEN
      RAISE EXCEPTION 'FAIL owner_blocked %: got % (NO_ERROR means RLS hid the row or the trigger misses the column)', v_col, v_got;
    END IF;
  END LOOP;
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'FAIL owner_blocked: role did not revert (%)', current_user;
  END IF;

  -- owner_allowed: an unprotected column is still editable (not a blanket block) ---------------------
  v_got := NULL;
  <<owner_allowed>>
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE public.user_shops SET shop_name = shop_name WHERE id = v_shop;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_got := 'rows=' || v_n;
  EXCEPTION WHEN OTHERS THEN
    v_got := SQLERRM;
  END owner_allowed;
  RESET ROLE;
  IF v_got IS DISTINCT FROM 'rows=1' THEN RAISE EXCEPTION 'FAIL owner_allowed: %', v_got; END IF;

  -- Service role from here on. ----------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- check_violation ---------------------------------------------------------
  FOREACH v_val IN ARRAY ARRAY[4, -1] LOOP
    v_got := NULL;
    <<check_violation>>
    BEGIN
      UPDATE public.user_shops SET price_reminders_sent = v_val WHERE id = v_shop;
      v_got := 'NO_ERROR';
    EXCEPTION WHEN check_violation THEN
      v_got := 'CHECK';
    WHEN OTHERS THEN
      v_got := 'OTHER: ' || SQLERRM;
    END check_violation;
    IF v_got IS DISTINCT FROM 'CHECK' THEN
      RAISE EXCEPTION 'FAIL check_violation %: got %', v_val, v_got;
    END IF;
  END LOOP;

  -- service_unaffected: service_role can set a valid value -------------------------------------------
  UPDATE public.user_shops SET price_reminders_sent = 3 WHERE id = v_shop;
  SELECT count(*) INTO v_n FROM public.user_shops WHERE id = v_shop AND price_reminders_sent = 3;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL service_unaffected: update did not apply (%)', v_n; END IF;

  -- Always roll back. -------------------------------------------------------
  RAISE EXCEPTION 'SELFTEST_OK 0149: all scenarios passed; rolling back';
END $selftest$;
