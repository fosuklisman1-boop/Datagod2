-- 0149_sub_agent_price_reminders.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0149_sub_agent_price_reminders.sql. Send this whole file as one
-- run: it opens a transaction, applies the migration statements (copied verbatim from 0149), then a DO block that
-- always RAISEs, which aborts the transaction so the column, the index and every test write are rolled back.
-- It never ends the transaction itself, and the DO body closes only with its labelled terminator. Before sending,
-- assert by code that the run string contains no transaction-ending statement. PASSES when the error text starts
-- with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed. If the client keeps the session open, send
-- `ROLLBACK;`. After the real apply, the DO block alone can be run inside `BEGIN; ...` the same way.
--
-- Scenarios: column (smallint, not null, default 0), existing_rows_zero, index (partial predicate on
-- joined_via + prices_set_at), claim (a conditional UPDATE on the old value wins once, a second with the stale
-- value updates nothing), idempotent (re-running the ALTER and CREATE INDEX is a no-op).

BEGIN;

ALTER TABLE public.user_shops ADD COLUMN IF NOT EXISTS price_reminders_sent smallint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS user_shops_price_reminder_scan_idx
  ON public.user_shops (price_reminders_sent, created_at)
  WHERE joined_via = 'storefront' AND prices_set_at IS NULL;

DO $selftest$
DECLARE
  v_n     int;
  v_def   text;
  v_pred  text;
  v_shop  uuid;
BEGIN
  -- column ------------------------------------------------------------------
  SELECT count(*), max(column_default) INTO v_n, v_def FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'user_shops' AND column_name = 'price_reminders_sent'
     AND data_type = 'smallint' AND is_nullable = 'NO';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL column: price_reminders_sent smallint not null found %', v_n; END IF;
  IF v_def IS NULL OR v_def NOT LIKE '0%' THEN RAISE EXCEPTION 'FAIL column: default is %', v_def; END IF;

  -- existing_rows_zero (only meaningful before the real apply) ---------------
  SELECT count(*) INTO v_n FROM public.user_shops WHERE price_reminders_sent IS DISTINCT FROM 0;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL existing_rows_zero: % rows not 0 (column existed before?)', v_n; END IF;

  -- index -------------------------------------------------------------------
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO v_pred
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'user_shops_price_reminder_scan_idx' AND i.indrelid = 'public.user_shops'::regclass;
  IF v_pred IS NULL THEN RAISE EXCEPTION 'FAIL index: missing or not partial'; END IF;
  IF v_pred NOT LIKE '%joined_via%storefront%' OR v_pred NOT LIKE '%prices_set_at IS NULL%' THEN
    RAISE EXCEPTION 'FAIL index: predicate is %', v_pred;
  END IF;

  -- claim -------------------------------------------------------------------
  SELECT id INTO v_shop FROM public.user_shops WHERE price_reminders_sent = 0 ORDER BY id LIMIT 1;
  IF v_shop IS NOT NULL THEN
    UPDATE public.user_shops SET price_reminders_sent = 2 WHERE id = v_shop AND price_reminders_sent = 0;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL claim: first claim updated % rows', v_n; END IF;
    UPDATE public.user_shops SET price_reminders_sent = 2 WHERE id = v_shop AND price_reminders_sent = 0;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL claim: stale claim updated % rows', v_n; END IF;
  END IF;

  -- idempotent --------------------------------------------------------------
  ALTER TABLE public.user_shops ADD COLUMN IF NOT EXISTS price_reminders_sent smallint NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS user_shops_price_reminder_scan_idx
    ON public.user_shops (price_reminders_sent, created_at)
    WHERE joined_via = 'storefront' AND prices_set_at IS NULL;

  -- Always roll back. -------------------------------------------------------
  RAISE EXCEPTION 'SELFTEST_OK 0149: all scenarios passed; rolling back';
END $selftest$;
