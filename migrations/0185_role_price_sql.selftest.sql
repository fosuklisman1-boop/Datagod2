-- 0185_role_price_sql.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0185_role_price_sql.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and that this DO block has no bare
-- `END;` statement and ends by raising. (The 0130 incident lesson.) Build it as lib/roles/migration-0185-run.ts does:
--   1. 0185_role_price_sql.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: nested blocks are labelled (`END b_x;`) and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new functions and every test
-- write below are rolled back. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it
-- failed. If the client keeps the session open, send `ROLLBACK;`.
--
-- Needs >= 3 packages. Checks role_price_for: dealer / user / admin / unknown role, a custom rank-20 role with a price row and the
-- ladder fallback to the dealer price and then the package price, an archived role, an off-ladder role, unknown / NULL package,
-- definer + pinned search_path, no EXECUTE for anon / authenticated, and that place_api_v2_order carries the new disjunct.

DO $selftest$
DECLARE
  v_p1      uuid;
  v_p2      uuid;
  v_p3      uuid;
  v_price1  numeric;
  v_price2  numeric;
  v_price3  numeric;
  v_gold    uuid;
  v_sub     uuid;
  v_got     numeric;
  v_def     text;
  v_role    text;
BEGIN
  SELECT id INTO v_p1 FROM public.packages ORDER BY id LIMIT 1;
  SELECT id INTO v_p2 FROM public.packages WHERE id > v_p1 ORDER BY id LIMIT 1;
  SELECT id INTO v_p3 FROM public.packages WHERE id > v_p2 ORDER BY id LIMIT 1;
  IF v_p3 IS NULL THEN RAISE EXCEPTION 'FAIL need_three_packages'; END IF;

  -- p1: dealer price > 0; p2: no dealer price; p3: dealer price > 0 (set through the 0184 mirror, rolled back)
  UPDATE public.packages SET dealer_price = 3.33 WHERE id = v_p1;
  UPDATE public.packages SET dealer_price = NULL WHERE id = v_p2;
  UPDATE public.packages SET dealer_price = 3.44 WHERE id = v_p3;
  SELECT price INTO v_price1 FROM public.packages WHERE id = v_p1;
  SELECT price INTO v_price2 FROM public.packages WHERE id = v_p2;
  SELECT price INTO v_price3 FROM public.packages WHERE id = v_p3;

  -- dealer
  v_got := public.role_price_for('dealer', v_p1);
  IF v_got IS DISTINCT FROM 3.33 THEN RAISE EXCEPTION 'FAIL dealer_price_with_dealer_row %', v_got; END IF;
  v_got := public.role_price_for('dealer', v_p2);
  IF v_got IS DISTINCT FROM v_price2 THEN RAISE EXCEPTION 'FAIL dealer_price_without_dealer_row %', v_got; END IF;
  UPDATE public.packages SET dealer_price = 0 WHERE id = v_p2;
  v_got := public.role_price_for('dealer', v_p2);
  IF v_got IS DISTINCT FROM v_price2 THEN RAISE EXCEPTION 'FAIL dealer_price_zero_dealer_price %', v_got; END IF;

  -- user / admin / unknown role: package price
  v_got := public.role_price_for('user', v_p1);
  IF v_got IS DISTINCT FROM v_price1 THEN RAISE EXCEPTION 'FAIL user_price %', v_got; END IF;
  v_got := public.role_price_for('admin', v_p1);
  IF v_got IS DISTINCT FROM v_price1 THEN RAISE EXCEPTION 'FAIL admin_price %', v_got; END IF;
  v_got := public.role_price_for('nope', v_p1);
  IF v_got IS DISTINCT FROM v_price1 THEN RAISE EXCEPTION 'FAIL unknown_role_price %', v_got; END IF;
  v_got := public.role_price_for(NULL, v_p1);
  IF v_got IS DISTINCT FROM v_price1 THEN RAISE EXCEPTION 'FAIL null_role_price %', v_got; END IF;

  -- unknown / NULL package -> NULL
  IF public.role_price_for('dealer', gen_random_uuid()) IS NOT NULL THEN RAISE EXCEPTION 'FAIL unknown_package_not_null'; END IF;
  IF public.role_price_for('dealer', NULL) IS NOT NULL THEN RAISE EXCEPTION 'FAIL null_package_not_null'; END IF;

  -- custom role above dealer: own row wins, then falls back to the dealer price, then to the package price
  INSERT INTO public.roles (slug, name, rank) VALUES ('selftest_gold', 'Selftest gold', 20) RETURNING id INTO v_gold;
  INSERT INTO public.role_package_prices (role_id, package_id, price) VALUES (v_gold, v_p3, 2.22);
  v_got := public.role_price_for('selftest_gold', v_p3);
  IF v_got IS DISTINCT FROM 2.22 THEN RAISE EXCEPTION 'FAIL custom_own_row %', v_got; END IF;
  v_got := public.role_price_for('selftest_gold', v_p1);
  IF v_got IS DISTINCT FROM 3.33 THEN RAISE EXCEPTION 'FAIL custom_falls_back_to_dealer %', v_got; END IF;
  v_got := public.role_price_for('selftest_gold', v_p2);
  IF v_got IS DISTINCT FROM v_price2 THEN RAISE EXCEPTION 'FAIL custom_falls_back_to_package %', v_got; END IF;
  -- a role BELOW the custom role does not see its row
  v_got := public.role_price_for('dealer', v_p3);
  IF v_got IS DISTINCT FROM 3.44 THEN RAISE EXCEPTION 'FAIL lower_role_saw_higher_row %', v_got; END IF;

  -- an archived role has no ladder: package price
  UPDATE public.roles SET archived_at = now() WHERE id = v_gold;
  v_got := public.role_price_for('selftest_gold', v_p3);
  IF v_got IS DISTINCT FROM v_price3 THEN RAISE EXCEPTION 'FAIL archived_role_not_package_price %', v_got; END IF;
  UPDATE public.roles SET archived_at = NULL WHERE id = v_gold;

  -- off-ladder role (rank NULL): own rows only, no fallback to dealer
  SELECT id INTO v_sub FROM public.roles WHERE slug = 'sub_agent';
  INSERT INTO public.role_package_prices (role_id, package_id, price) VALUES (v_sub, v_p1, 1.50);
  v_got := public.role_price_for('sub_agent', v_p1);
  IF v_got IS DISTINCT FROM 1.50 THEN RAISE EXCEPTION 'FAIL offladder_own_row %', v_got; END IF;
  v_got := public.role_price_for('sub_agent', v_p3);
  IF v_got IS DISTINCT FROM v_price3 THEN RAISE EXCEPTION 'FAIL offladder_no_fallback %', v_got; END IF;

  -- definer + pinned search_path + no EXECUTE for anon / authenticated
  IF NOT coalesce((SELECT prosecdef FROM pg_proc WHERE oid = 'public.role_price_for(text,uuid)'::regprocedure), false) THEN
    RAISE EXCEPTION 'FAIL role_price_for_not_security_definer';
  END IF;
  IF NOT coalesce((SELECT 'search_path=public' = ANY (proconfig) FROM pg_proc WHERE oid = 'public.role_price_for(text,uuid)'::regprocedure), false) THEN
    RAISE EXCEPTION 'FAIL role_price_for_search_path_not_pinned';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(v_role, 'public.role_price_for(text,uuid)'::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL role_price_for_execute_granted %', v_role;
    END IF;
    IF has_function_privilege(v_role, 'public.place_api_v2_order(uuid,uuid,uuid,text,numeric,numeric,text,text,text)'::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL place_api_v2_order_execute_granted %', v_role;
    END IF;
  END LOOP;

  -- the v2 RPC carries the new disjunct and still carries the old ones
  v_def := pg_get_functiondef('public.place_api_v2_order(uuid,uuid,uuid,text,numeric,numeric,text,text,text)'::regprocedure);
  IF position('OR p_price = public.role_price_for((SELECT u2.role FROM public.users u2 WHERE u2.id = p_user_id), p.id)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL v2_rpc_missing_role_disjunct';
  END IF;
  IF position('p_price = p.price OR (p.dealer_price > 0 AND p_price = p.dealer_price)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL v2_rpc_lost_price_disjuncts';
  END IF;
  IF position('upp.price = p_price' IN v_def) = 0 THEN RAISE EXCEPTION 'FAIL v2_rpc_lost_custom_disjunct'; END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0185 (rolled back)';
END $selftest$;
