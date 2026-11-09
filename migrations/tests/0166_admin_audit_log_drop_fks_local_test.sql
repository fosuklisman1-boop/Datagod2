-- LOCAL ONLY. Never run against production: it creates stub tables and an auth schema.
-- Renamed from 0151_admin_audit_log_drop_fks_local_test.sql. The migration it tests was already applied to production on 2026-11-09 (as 0151_admin_audit_log_drop_fks.sql).
--
-- Exercises 0166_admin_audit_log_drop_fks.sql on admin_audit_log exactly as 0069 creates it, in an EMPTY
-- database. Run from the repo root:
--
--   createdb audit_fk_test
--   psql -v ON_ERROR_STOP=1 -d audit_fk_test -f migrations/tests/0166_admin_audit_log_drop_fks_local_test.sql
--
-- Passes when it prints ADMIN_AUDIT_LOG_FK_LOCAL_TEST_OK. Any failed ASSERT aborts.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, created_at timestamptz DEFAULT now());
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TABLE public.users (id uuid PRIMARY KEY, role text);
-- What 0069's two SQL-language / plpgsql functions read, so the real 0069 applies as is.
CREATE TABLE public.sms_accounts (id uuid PRIMARY KEY, status text, amount_paid numeric, updated_at timestamptz);
CREATE TABLE public.sms_unit_transactions (id uuid PRIMARY KEY, delta int, reason text);

\i migrations/0069_admin_moderation_sms.sql
-- The tables 0164 adds (they cascade / set null themselves; 0166 does not touch them).
CREATE TABLE public.orders (id uuid);
\i migrations/0164_admin_user_notes_tags.sql

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000ad'),   -- admin who acted
  ('00000000-0000-0000-0000-00000000000a'),   -- a user who will be deleted
  ('00000000-0000-0000-0000-00000000000b');   -- a user who stays
INSERT INTO public.admin_audit_log (admin_id, action, target_user_id) VALUES
  ('00000000-0000-0000-0000-0000000000ad', 'user_notify', '00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-0000000000ad', 'user_notify', '00000000-0000-0000-0000-00000000000b');
INSERT INTO public.admin_user_notes (user_id, author_id, body) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000ad', 'n');
INSERT INTO public.admin_user_tags (user_id, tag) VALUES ('00000000-0000-0000-0000-00000000000a', 'vip');

-- Before 0166: an audited user cannot be deleted (this is what left remove-user half done).
DO $$ BEGIN
  BEGIN
    DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-00000000000a';
    RAISE EXCEPTION 'delete should have been blocked before 0166';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- An environment where the target FK carries another name (and a second, duplicate FK): 0166 finds them by
-- column, not by name.
ALTER TABLE public.admin_audit_log RENAME CONSTRAINT admin_audit_log_target_user_id_fkey TO some_old_name;
ALTER TABLE public.admin_audit_log ADD CONSTRAINT dup_target_fk FOREIGN KEY (target_user_id) REFERENCES auth.users(id);

\i migrations/0166_admin_audit_log_drop_fks.sql
-- Idempotent: a second apply succeeds and changes nothing.
\i migrations/0166_admin_audit_log_drop_fks.sql

DO $$
DECLARE
  n int;
BEGIN
  -- no foreign key left on admin_audit_log; admin_id nullable (CRON-bypass rows have no admin)
  SELECT count(*) INTO n FROM pg_constraint WHERE conrelid = 'public.admin_audit_log'::regclass AND contype = 'f';
  ASSERT n = 0, format('no FKs, got %s', n);
  ASSERT (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid = 'public.admin_audit_log'::regclass AND attname = 'admin_id'), 'admin_id nullable';

  -- deleting an audited user works, and their audit rows keep the original uuids; notes and tags go
  DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-00000000000a';
  ASSERT (SELECT count(*) FROM public.admin_audit_log) = 2, 'audit rows kept';
  ASSERT (SELECT count(*) FROM public.admin_audit_log WHERE target_user_id = '00000000-0000-0000-0000-00000000000a'
            AND admin_id = '00000000-0000-0000-0000-0000000000ad') = 1, 'target uuid kept';
  ASSERT NOT EXISTS (SELECT 1 FROM public.admin_audit_log WHERE target_user_id IS NULL OR admin_id IS NULL), 'nothing nulled';
  ASSERT NOT EXISTS (SELECT 1 FROM public.admin_user_notes), 'notes cascade';
  ASSERT NOT EXISTS (SELECT 1 FROM public.admin_user_tags), 'tags cascade';

  -- deleting the admin who acted keeps their id on every row
  DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-0000000000ad';
  ASSERT (SELECT count(*) FROM public.admin_audit_log WHERE admin_id = '00000000-0000-0000-0000-0000000000ad') = 2, 'admin uuid kept';

  -- a CRON-bypass action (no admin) can now be recorded
  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id) VALUES (NULL, 'set_admin', '00000000-0000-0000-0000-00000000000b');

  RAISE NOTICE 'ADMIN_AUDIT_LOG_FK_LOCAL_TEST_OK';
END $$;
