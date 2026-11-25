-- 0196_ai_drafts_admin_route_call.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0196_ai_drafts_admin_route_call.sql.
--
-- IMPORTANT: the run string must be built by CODE (lib/ai-admin-catalog/migration-0196-run.ts), never by hand: it keeps BEGIN and
-- both SET LOCALs, removes ONLY the final COMMIT line, then appends this file from the line that STARTS (column 0) with
-- the DO keyword onward; the code asserts no COMMIT and no bare END; and that it ends by raising. (The 0130 lesson.)
-- The DO body has no bare end statement: nested blocks are labelled and the block closes with the labelled dollar tag.
--
-- The DO block always ends with RAISE EXCEPTION, which aborts the explicit transaction, so the widened CHECK and every test
-- write are undone. PASSES when the error text starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
-- If the client keeps the session open, send ROLLBACK.
--
-- Checks: the action CHECK definition lists all seven names; if a public.users row already exists, an admin_route_call draft
-- inserts and a 'bogus' action is refused with check_violation. It never inserts or deletes public.users rows (prod users
-- rows are tied to auth.users): with no existing user the insert checks are skipped and only the catalog check runs.

DO $selftest$
DECLARE
  v_def  text;
  v_a    text;
  v_u    uuid;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c
   WHERE c.conrelid = 'public.ai_drafts'::regclass AND c.conname = 'ai_drafts_action_check' AND c.contype = 'c';
  IF v_def IS NULL THEN RAISE EXCEPTION 'FAIL action_check_missing'; END IF;

  FOREACH v_a IN ARRAY ARRAY['wallet_order','wallet_adjustment','withdrawal_action','user_suspension','role_change','bulk_status_update','admin_route_call'] LOOP
    IF position('''' || v_a || '''' IN v_def) = 0 THEN RAISE EXCEPTION 'FAIL action_not_listed %', v_a; END IF;
  END LOOP;

  SELECT id INTO v_u FROM public.users ORDER BY id LIMIT 1;   -- existing row or NULL; never created or deleted here

  IF v_u IS NOT NULL THEN
    INSERT INTO public.ai_drafts(user_id, context, action, params, display, expires_at)
    VALUES (v_u, 'admin', 'admin_route_call', '{}'::jsonb, '{}'::jsonb, now() + interval '1 hour');

    <<b_bogus>>
    BEGIN
      INSERT INTO public.ai_drafts(user_id, context, action, params, display, expires_at)
      VALUES (v_u, 'admin', 'bogus', '{}'::jsonb, '{}'::jsonb, now() + interval '1 hour');
      RAISE EXCEPTION 'FAIL bogus_action_accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END b_bogus;
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK 0196 (rolled back)';
END $selftest$;
