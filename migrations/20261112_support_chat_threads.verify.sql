-- Verify script for 20261112_support_chat_threads.sql. Read-only apart from a DO block that rolls itself back.
--
-- HOW TO RUN (after the migration is applied, or inside the dry-run transaction before its final RAISE):
--   Statement A (the SELECT) and statement B (the DO block) are separate statements; run both.
--
--   Statement A returns one row per check as (check_name text, ok boolean).
--     SUCCESS = every row has ok = true.
--   Statement B exercises the cap trigger, the one-order constraint, the last_message_at bump
--     and the ai role / handler default. It always ends in an exception so nothing persists.
--     SUCCESS = the ONLY error is:  ROLLBACK_OK
--     FAILURE = any other error; its text begins with "VERIFY_FAILED:" and names the assertion.

-- ===== Statement A: structure, privileges, RLS, realtime =====
SELECT check_name, ok FROM (
  SELECT 1 AS n, 'authenticated SELECT support_threads' AS check_name,
         has_table_privilege('authenticated','public.support_threads','SELECT') AS ok
  UNION ALL SELECT 2,  'authenticated no INSERT support_threads', NOT has_table_privilege('authenticated','public.support_threads','INSERT')
  UNION ALL SELECT 3,  'authenticated no UPDATE support_threads', NOT has_table_privilege('authenticated','public.support_threads','UPDATE')
  UNION ALL SELECT 4,  'authenticated no DELETE support_threads', NOT has_table_privilege('authenticated','public.support_threads','DELETE')
  UNION ALL SELECT 5,  'authenticated SELECT support_messages', has_table_privilege('authenticated','public.support_messages','SELECT')
  UNION ALL SELECT 6,  'authenticated no INSERT support_messages', NOT has_table_privilege('authenticated','public.support_messages','INSERT')
  UNION ALL SELECT 7,  'authenticated no table-level UPDATE support_messages',
         NOT has_table_privilege('authenticated','public.support_messages','UPDATE')
  UNION ALL SELECT 8,  'authenticated no DELETE support_messages', NOT has_table_privilege('authenticated','public.support_messages','DELETE')
  UNION ALL SELECT 9,  'authenticated UPDATE column read_by_user_at',
         has_column_privilege('authenticated','public.support_messages','read_by_user_at','UPDATE')
  UNION ALL SELECT 10, 'authenticated UPDATE column delivered_to_user_at',
         has_column_privilege('authenticated','public.support_messages','delivered_to_user_at','UPDATE')
  UNION ALL SELECT 11, 'authenticated no UPDATE column body',
         NOT has_column_privilege('authenticated','public.support_messages','body','UPDATE')
  UNION ALL SELECT 12, 'authenticated no UPDATE column read_by_admin_at',
         NOT has_column_privilege('authenticated','public.support_messages','read_by_admin_at','UPDATE')
  UNION ALL SELECT 13, 'anon no privilege support_threads',
         NOT (has_table_privilege('anon','public.support_threads','SELECT') OR has_table_privilege('anon','public.support_threads','INSERT')
              OR has_table_privilege('anon','public.support_threads','UPDATE') OR has_table_privilege('anon','public.support_threads','DELETE'))
  UNION ALL SELECT 14, 'anon no privilege support_messages',
         NOT (has_table_privilege('anon','public.support_messages','SELECT') OR has_table_privilege('anon','public.support_messages','INSERT')
              OR has_table_privilege('anon','public.support_messages','UPDATE') OR has_table_privilege('anon','public.support_messages','DELETE'))
  UNION ALL SELECT 15, 'anon no privilege admin_presence',
         NOT (has_table_privilege('anon','public.admin_presence','SELECT') OR has_table_privilege('anon','public.admin_presence','INSERT')
              OR has_table_privilege('anon','public.admin_presence','UPDATE') OR has_table_privilege('anon','public.admin_presence','DELETE'))
  UNION ALL SELECT 16, 'authenticated no privilege admin_presence',
         NOT (has_table_privilege('authenticated','public.admin_presence','SELECT') OR has_table_privilege('authenticated','public.admin_presence','INSERT')
              OR has_table_privilege('authenticated','public.admin_presence','UPDATE') OR has_table_privilege('authenticated','public.admin_presence','DELETE'))
  UNION ALL SELECT 17, 'RLS enabled support_threads',
         COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.support_threads'::regclass), false)
  UNION ALL SELECT 18, 'RLS enabled support_messages',
         COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.support_messages'::regclass), false)
  UNION ALL SELECT 19, 'RLS enabled admin_presence',
         COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_presence'::regclass), false)
  UNION ALL SELECT 20, 'admin_presence has no policies',
         NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_presence')
  UNION ALL SELECT 21, 'complaints has no INSERT/ALL policy',
         NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'complaints' AND cmd IN ('INSERT','ALL'))
  UNION ALL SELECT 22, 'complaints: authenticated/anon no INSERT/UPDATE/DELETE',
         NOT (has_table_privilege('authenticated','public.complaints','INSERT') OR has_table_privilege('authenticated','public.complaints','UPDATE')
              OR has_table_privilege('authenticated','public.complaints','DELETE')
              OR has_table_privilege('anon','public.complaints','INSERT') OR has_table_privilege('anon','public.complaints','UPDATE')
              OR has_table_privilege('anon','public.complaints','DELETE'))
  UNION ALL SELECT 23, 'support_messages in supabase_realtime',
         EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'support_messages')
  UNION ALL SELECT 24, 'support_threads in supabase_realtime',
         EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'support_threads')
  UNION ALL SELECT 25, 'security_alerts still in supabase_realtime',
         EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'security_alerts')
  UNION ALL SELECT 26, 'cap trigger present',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.support_threads'::regclass AND tgname = 'trg_support_thread_cap' AND NOT tgisinternal)
  UNION ALL SELECT 27, 'bump trigger present',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.support_messages'::regclass AND tgname = 'trg_support_thread_bump' AND NOT tgisinternal)
  UNION ALL SELECT 28, 'one-order constraint present',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_threads'::regclass AND conname = 'support_threads_one_order')
) c ORDER BY n;

-- ===== Statement B: behaviour tests, always rolls back =====
DO $$
DECLARE
  v_user       uuid;
  v_thread     uuid;
  v_thread4    uuid;
  v_old        timestamptz := now() - interval '1 day';
  v_after      timestamptz;
  v_handler    text;
  v_cname      text;
  v_msg        text;
  v_failed     boolean;
  i            integer;
BEGIN
  -- Prefer a user with no open threads so the cap test is deterministic.
  SELECT u.id INTO v_user FROM public.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.support_threads t WHERE t.user_id = u.id AND t.status = 'open')
   LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'VERIFY_FAILED: no user without open support threads available for the test';
  END IF;

  -- Assertion 1: three open threads insert fine.
  FOR i IN 1..3 LOOP
    INSERT INTO public.support_threads (user_id, subject, phone_number, whatsapp_number, last_message_at)
    VALUES (v_user, 'verify thread ' || i, '0240000000', '0240000000', v_old)
    RETURNING id INTO v_thread;
  END LOOP;
  SELECT handler INTO v_handler FROM public.support_threads WHERE id = v_thread;
  IF v_handler IS DISTINCT FROM 'human' THEN
    RAISE EXCEPTION 'VERIFY_FAILED: handler default is not human (got %)', v_handler;
  END IF;

  -- Assertion 2: the 4th open thread raises OPEN_THREAD_LIMIT.
  v_failed := false;
  BEGIN
    INSERT INTO public.support_threads (user_id, subject, phone_number, whatsapp_number)
    VALUES (v_user, 'verify thread 4', '0240000000', '0240000000')
    RETURNING id INTO v_thread4;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg = 'OPEN_THREAD_LIMIT' THEN
      v_failed := true;
    ELSE
      RAISE EXCEPTION 'VERIFY_FAILED: 4th thread raised an unexpected error: %', v_msg;
    END IF;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'VERIFY_FAILED: 4th open thread was not blocked by OPEN_THREAD_LIMIT';
  END IF;

  -- Assertion 3: both order_id and shop_order_id violates support_threads_one_order.
  -- (CHECK constraints run before FK triggers, so random ids are enough; the cap is the only
  -- other thing that could fire, so close one thread first to free a slot.)
  UPDATE public.support_threads SET status = 'closed', closed_at = now() WHERE id = v_thread;
  v_failed := false;
  BEGIN
    INSERT INTO public.support_threads (user_id, order_id, shop_order_id, subject, phone_number, whatsapp_number)
    VALUES (v_user, gen_random_uuid(), gen_random_uuid(), 'verify both orders', '0240000000', '0240000000');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_cname = CONSTRAINT_NAME;
    IF v_cname = 'support_threads_one_order' THEN
      v_failed := true;
    ELSE
      RAISE EXCEPTION 'VERIFY_FAILED: wrong constraint fired for both-orders insert: %', v_cname;
    END IF;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'VERIFY_FAILED: thread with both order_id and shop_order_id was accepted';
  END IF;

  -- Assertion 4: closing a thread frees a cap slot (a new open thread now succeeds).
  INSERT INTO public.support_threads (user_id, subject, phone_number, whatsapp_number, last_message_at)
  VALUES (v_user, 'verify reopened slot', '0240000000', '0240000000', v_old)
  RETURNING id INTO v_thread;

  -- Assertion 5: inserting a message bumps last_message_at.
  INSERT INTO public.support_messages (thread_id, sender_role, sender_id, body)
  VALUES (v_thread, 'user', v_user, 'verify message');
  SELECT last_message_at INTO v_after FROM public.support_threads WHERE id = v_thread;
  IF v_after IS NULL OR v_after <= v_old THEN
    RAISE EXCEPTION 'VERIFY_FAILED: message insert did not bump last_message_at (got %)', v_after;
  END IF;

  -- Assertion 6: the ai sender role is accepted; an unknown role is rejected.
  INSERT INTO public.support_messages (thread_id, sender_role, sender_id, body)
  VALUES (v_thread, 'ai', v_user, 'verify ai message');
  v_failed := false;
  BEGIN
    INSERT INTO public.support_messages (thread_id, sender_role, sender_id, body)
    VALUES (v_thread, 'bot', v_user, 'verify bad role');
  EXCEPTION WHEN check_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'VERIFY_FAILED: unknown sender_role was accepted';
  END IF;

  RAISE EXCEPTION 'ROLLBACK_OK';
END $$;
