-- 0133_leaderboard_engine.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0133_leaderboard_engine.sql
-- against real data. Fixture-level checks (exact totals, sub-agent and
-- storefront attribution, tie-breaks, refunds) live in
-- migrations/tests/0133_leaderboard_engine_local_test.sql, which needs a stub
-- schema; this file checks the migration against production shapes instead.
--
-- Build the run string by code, as for 0132:
--   1. 0133_leaderboard_engine.sql with BEGIN and both SET LOCALs kept and ONLY
--      its final transaction-ending line removed (the trailing "Verify after
--      apply" comment lines may stay);
--   2. followed by this file from the line that STARTS (column 0) with the DO
--      keyword onward.
--   Assert the run string has no COMMIT and no bare `END;` statement. The DO
--   body has none: its only block end is the final dollar-quoted one.
--
-- The DO block always ends with RAISE EXCEPTION, so the new column, backfill,
-- tables, view and functions are all rolled back. PASSES when the error text
-- starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- After the real apply the DO block can also be run alone inside `BEGIN; ...`
-- (never ended with a commit).

DO $$
DECLARE
  v_from date := (now() AT TIME ZONE 'Africa/Accra')::date - 2;
  v_to   date := (now() AT TIME ZONE 'Africa/Accra')::date;
  v_rows int;
  v_rows2 int;
  v_view numeric;
  v_roll numeric;
  v_board text;
  v jsonb;
  v_stock int;
  v_admins int;
BEGIN
  SELECT count(*) INTO v_stock FROM public.shop_orders WHERE is_stock_purchase;

  v_rows := public.refresh_leaderboard_totals(v_from, v_to);
  v_rows2 := public.refresh_leaderboard_totals(v_from, v_to);
  IF v_rows <> v_rows2 THEN
    RAISE EXCEPTION 'FAIL refresh not idempotent: % then % rows', v_rows, v_rows2;
  END IF;

  FOREACH v_board IN ARRAY ARRAY['dashboard','shop'] LOOP
    SELECT COALESCE(round(sum(e.amount), 2), 0) INTO v_view
      FROM public.leaderboard_sales_events e
     WHERE e.board = v_board
       AND e.sold_at >= (v_from::timestamp AT TIME ZONE 'Africa/Accra')
       AND e.sold_at <  ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Accra');
    SELECT COALESCE(sum(t.total_amount), 0) INTO v_roll
      FROM public.leaderboard_daily_totals t
     WHERE t.board = v_board AND t.day BETWEEN v_from AND v_to;
    -- per-user-day rounding can move the grand total by at most a cent a row
    IF abs(v_view - v_roll) > 0.01 * GREATEST(v_rows, 1) THEN
      RAISE EXCEPTION 'FAIL % rollup % <> view %', v_board, v_roll, v_view;
    END IF;

    v := public.get_leaderboard(v_board, v_from, v_to, 30);
    IF jsonb_typeof(v->'entries') <> 'array' OR jsonb_array_length(v->'entries') > 30 THEN
      RAISE EXCEPTION 'FAIL % get_leaderboard shape: %', v_board, left(v::text, 300);
    END IF;

    SELECT count(*) INTO v_admins
      FROM jsonb_array_elements(v->'entries') x
      JOIN public.users u ON u.id = (x->>'user_id')::uuid
     WHERE u.role = 'admin';
    IF v_admins > 0 THEN
      RAISE EXCEPTION 'FAIL % board ranks % admin(s)', v_board, v_admins;
    END IF;

    IF jsonb_array_length(v->'entries') > 0 THEN
      v := public.get_leaderboard_rank((v->'entries'->0->>'user_id')::uuid, v_board, v_from, v_to);
      IF (v->>'rank')::int IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'FAIL % rank of #1 is %', v_board, v->>'rank';
      END IF;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'SELFTEST_OK rows=% stock_purchases_flagged=% window=%..%', v_rows, v_stock, v_from, v_to;
END $$;
