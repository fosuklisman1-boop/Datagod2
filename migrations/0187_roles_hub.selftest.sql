-- 0187_roles_hub.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0187_roles_hub.sql.
--
-- IMPORTANT: the run string must be built by CODE, never by hand or by a regex strip, and that code must
-- ASSERT before anything is sent to production that the run string contains no COMMIT and that this DO block has no bare
-- `END;` statement and ends by raising. (The 0130 incident lesson.) Build it as lib/roles/migration-0187-run.ts does:
--   1. 0187_roles_hub.sql with BEGIN kept (and both SET LOCALs) and ONLY its final COMMIT line removed;
--   2. followed by this file from the line that STARTS (column 0) with the DO keyword onward. The header
--      is not part of the run string (it names the forbidden words).
--   The DO body has no bare `END;`: nested blocks are labelled (`END b_x;`) and the block closes with `END $selftest$;`.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the new tables, the seeds and
-- every test write below are undone. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error
-- means it failed. If the client keeps the session open, send `ROLLBACK;`.
--
-- Checks: tables exist with RLS on and no client privilege, 14 seeded capabilities for user and dealer, anon / authenticated
-- cannot EXECUTE the write functions, one audited round trip (create, set_prices with context, price_external from a direct
-- dealer_price write, below-cost refusal, archive), and the append-only log. Uses an existing packages row (skips the price
-- checks when the table is empty). Never deletes roles: the audit log references them.

DO $selftest$
DECLARE
  v_n      int;
  v_who    text;
  v_t      text;
  v_fn     regprocedure;
  v_actor  uuid := gen_random_uuid();
  v_role   uuid;
  v_pkg    uuid;
  v_dealer uuid;
  v_old    numeric;
  v_rank   int;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['role_permissions', 'role_audit_log', 'package_costs'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN RAISE EXCEPTION 'FAIL table_missing %', v_t; END IF;
    IF NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass), false) THEN
      RAISE EXCEPTION 'FAIL rls_not_enabled %', v_t;
    END IF;
    FOREACH v_who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(v_who, 'public.' || v_t, 'SELECT') OR has_table_privilege(v_who, 'public.' || v_t, 'INSERT')
         OR has_table_privilege(v_who, 'public.' || v_t, 'UPDATE') OR has_table_privilege(v_who, 'public.' || v_t, 'DELETE') THEN
        RAISE EXCEPTION 'FAIL client_role_has_privilege % %', v_who, v_t;
      END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('service_role', 'public.role_audit_log', 'UPDATE')
     OR has_table_privilege('service_role', 'public.role_audit_log', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL audit_log_not_append_only_for_service_role';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.role_audit_log', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.role_permissions', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL service_role_lacks_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'packages' AND column_name = 'cost_price') THEN
    RAISE EXCEPTION 'FAIL cost_price_on_public_packages';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'package_costs') THEN
    RAISE EXCEPTION 'FAIL package_costs_has_policy';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.package_costs', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL service_role_lacks_package_costs';
  END IF;

  -- seeds
  SELECT count(*) INTO v_n FROM public.role_permissions p JOIN public.roles r ON r.id = p.role_id WHERE r.slug = 'user';
  IF v_n < 14 THEN RAISE EXCEPTION 'FAIL user_caps %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.role_permissions p JOIN public.roles r ON r.id = p.role_id WHERE r.slug = 'dealer';
  IF v_n < 14 THEN RAISE EXCEPTION 'FAIL dealer_caps %', v_n; END IF;

  -- the write functions are closed to client roles
  FOR v_fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname LIKE 'admin\_role\_%' LOOP
    FOREACH v_who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_who, v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL client_can_execute % %', v_who, v_fn; END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL service_role_cannot_execute %', v_fn; END IF;
  END LOOP;

  -- argument checks
  <<b_actor>>
  BEGIN
    PERFORM public.admin_role_archive(NULL, 'selftest reason', gen_random_uuid());
    RAISE EXCEPTION 'FAIL null_actor_accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'actor required%' THEN RAISE; END IF;
  END b_actor;
  <<b_reason>>
  BEGIN
    PERFORM public.admin_role_archive(v_actor, 'ab', gen_random_uuid());
    RAISE EXCEPTION 'FAIL short_reason_accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'reason required%' THEN RAISE; END IF;
  END b_reason;

  -- audited round trip
  SELECT coalesce(max(rank), 0) + 1000 INTO v_rank FROM public.roles;
  v_role := public.admin_role_create(v_actor, 'selftest create', 'selftest_hub', 'Selftest hub', v_rank, NULL);
  IF NOT EXISTS (SELECT 1 FROM public.role_audit_log WHERE role_id = v_role AND action = 'create' AND actor_id = v_actor) THEN
    RAISE EXCEPTION 'FAIL create_not_audited';
  END IF;

  SELECT id INTO v_pkg FROM public.packages ORDER BY id LIMIT 1;
  IF v_pkg IS NOT NULL THEN
    PERFORM public.admin_role_set_prices(v_actor, 'selftest prices', v_role,
      jsonb_build_array(jsonb_build_object('package_id', v_pkg, 'price', 7.25)), false);
    IF NOT EXISTS (SELECT 1 FROM public.role_audit_log WHERE role_id = v_role AND action = 'prices' AND actor_id = v_actor
                    AND after = jsonb_build_array(jsonb_build_object('package_id', v_pkg, 'price', 7.25))) THEN
      RAISE EXCEPTION 'FAIL prices_not_audited';
    END IF;

    INSERT INTO public.package_costs (package_id, cost_price) VALUES (v_pkg, 8)
      ON CONFLICT (package_id) DO UPDATE SET cost_price = 8;
    <<b_cost>>
    BEGIN
      PERFORM public.admin_role_set_prices(v_actor, 'selftest prices', v_role,
        jsonb_build_array(jsonb_build_object('package_id', v_pkg, 'price', 7)), false);
      RAISE EXCEPTION 'FAIL below_cost_accepted';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE '%below cost%' THEN RAISE; END IF;
    END b_cost;
    PERFORM public.admin_role_set_prices(v_actor, 'selftest prices', v_role,
      jsonb_build_array(jsonb_build_object('package_id', v_pkg, 'price', 7)), true);
    IF NOT EXISTS (SELECT 1 FROM public.role_audit_log WHERE role_id = v_role AND action = 'prices' AND loss_override) THEN
      RAISE EXCEPTION 'FAIL loss_override_not_recorded';
    END IF;

    -- a direct write of the legacy column is audited with no actor
    SELECT id INTO v_dealer FROM public.roles WHERE slug = 'dealer';
    SELECT dealer_price INTO v_old FROM public.packages WHERE id = v_pkg;
    UPDATE public.packages SET dealer_price = coalesce(v_old, 0) + 1.11 WHERE id = v_pkg;
    IF NOT EXISTS (SELECT 1 FROM public.role_audit_log WHERE role_id = v_dealer AND action = 'price_external' AND actor_id IS NULL) THEN
      RAISE EXCEPTION 'FAIL external_write_not_audited';
    END IF;
  END IF;

  PERFORM public.admin_role_archive(v_actor, 'selftest archive', v_role);
  IF NOT EXISTS (SELECT 1 FROM public.role_audit_log WHERE role_id = v_role AND action = 'archive') THEN
    RAISE EXCEPTION 'FAIL archive_not_audited';
  END IF;

  -- the log is append-only
  <<b_upd>>
  BEGIN
    UPDATE public.role_audit_log SET reason = 'x' WHERE role_id = v_role;
    RAISE EXCEPTION 'FAIL audit_update_accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END b_upd;
  <<b_del>>
  BEGIN
    DELETE FROM public.role_audit_log WHERE role_id = v_role;
    RAISE EXCEPTION 'FAIL audit_delete_accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END b_del;

  RAISE EXCEPTION 'SELFTEST_OK 0187 (rolled back)';
END $selftest$;
