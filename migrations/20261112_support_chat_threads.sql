-- Support chat threads: threads, messages, admin presence, open-thread cap, RLS, realtime.
-- Tables are server-write-only: the browser may SELECT and flip its own receipt columns
-- (read_by_user_at, delivered_to_user_at). Every other write goes through API routes
-- using the service-role client.
--
-- Re-runnable: CREATE ... IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS, guarded publication adds.
-- Prerequisites: public.users(id), public.orders(id), public.shop_orders(id), public.complaints,
-- uuid_generate_v4(), publication supabase_realtime.

BEGIN;

-- 1. Threads and messages ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.support_threads (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         uuid NOT NULL REFERENCES public.users(id)       ON DELETE CASCADE,
  order_id        uuid          REFERENCES public.orders(id)      ON DELETE SET NULL,
  shop_order_id   uuid          REFERENCES public.shop_orders(id) ON DELETE SET NULL,
  subject         text NOT NULL,
  category        text NOT NULL DEFAULT 'other'
                    CHECK (category IN ('order','payment','account','other')),
  phone_number    text NOT NULL,
  whatsapp_number text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  handler         text NOT NULL DEFAULT 'human' CHECK (handler IN ('ai','human')),
  needs_human_at  timestamptz,
  closed_at       timestamptz,
  closed_by       uuid,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_threads_one_order CHECK (order_id IS NULL OR shop_order_id IS NULL)
);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  thread_id             uuid NOT NULL REFERENCES public.support_threads(id) ON DELETE CASCADE,
  sender_role           text NOT NULL CHECK (sender_role IN ('user','admin','ai')),
  sender_id             uuid NOT NULL,
  body                  text NOT NULL,
  attachment_path       text,
  -- direction-scoped receipts (a message's counterpart is fixed by sender_role)
  delivered_to_user_at  timestamptz,
  delivered_to_admin_at timestamptz,
  read_by_user_at       timestamptz,
  read_by_admin_at      timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_threads_user_id       ON public.support_threads(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_threads_status        ON public.support_threads(status,  last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_thread       ON public.support_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_threads_order_id      ON public.support_threads(order_id)      WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_threads_shop_order_id ON public.support_threads(shop_order_id) WHERE shop_order_id IS NOT NULL;

-- 2. Open-thread cap: max 3 open threads per user, RACE-SAFE -------------------
-- The advisory lock serialises inserts per user so two parallel taps cannot both pass the count.
CREATE OR REPLACE FUNCTION public.enforce_support_thread_cap() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE open_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('support_thread_cap:' || NEW.user_id::text));
  SELECT count(*) INTO open_count FROM public.support_threads
   WHERE user_id = NEW.user_id AND status = 'open';
  IF open_count >= 3 THEN
    RAISE EXCEPTION 'OPEN_THREAD_LIMIT' USING HINT = 'A user may have at most 3 open support threads.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_support_thread_cap ON public.support_threads;
CREATE TRIGGER trg_support_thread_cap BEFORE INSERT ON public.support_threads
  FOR EACH ROW EXECUTE FUNCTION public.enforce_support_thread_cap();

-- 3. Keep last_message_at atomic (API routes can never forget it) --------------
CREATE OR REPLACE FUNCTION public.bump_support_thread_last_message() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  UPDATE public.support_threads SET last_message_at = NEW.created_at, updated_at = now()
   WHERE id = NEW.thread_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_support_thread_bump ON public.support_messages;
CREATE TRIGGER trg_support_thread_bump AFTER INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_support_thread_last_message();

CREATE OR REPLACE FUNCTION public.update_support_threads_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_support_threads_updated_at ON public.support_threads;
CREATE TRIGGER trg_support_threads_updated_at BEFORE UPDATE ON public.support_threads
  FOR EACH ROW EXECUTE FUNCTION public.update_support_threads_updated_at();

-- 4. RLS + grants --------------------------------------------------------------
ALTER TABLE public.support_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_threads_owner_select ON public.support_threads;
CREATE POLICY support_threads_owner_select ON public.support_threads
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS support_messages_owner_select ON public.support_messages;
CREATE POLICY support_messages_owner_select ON public.support_messages
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.support_threads t WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS support_messages_owner_mark_read ON public.support_messages;
CREATE POLICY support_messages_owner_mark_read ON public.support_messages
  FOR UPDATE TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.support_threads t WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.support_threads t WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())));

-- Supabase auto-grants CRUD on new tables: strip it, then grant the minimum.
REVOKE ALL ON public.support_threads  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.support_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.support_threads  TO authenticated;
GRANT SELECT ON public.support_messages TO authenticated;
-- Column-level: the user may only ever write THEIR direction's receipt columns.
GRANT UPDATE (read_by_user_at, delivered_to_user_at) ON public.support_messages TO authenticated;

-- 5. Realtime (postgres_changes is RLS-guarded) --------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'support_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.support_messages;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'support_threads') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.support_threads;
  END IF;
END $$;

-- 6. "Support active now" heartbeat --------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_presence (
  admin_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_presence ENABLE ROW LEVEL SECURITY;   -- no policies = deny-all
REVOKE ALL ON public.admin_presence FROM PUBLIC, anon, authenticated;

-- 7. Legacy complaints: no more client-side writes (inserts go through API routes)
DROP POLICY IF EXISTS "Users can insert own complaints" ON public.complaints;
REVOKE INSERT, UPDATE, DELETE ON public.complaints FROM anon, authenticated;

COMMIT;
