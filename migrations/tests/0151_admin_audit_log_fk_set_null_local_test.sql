-- LOCAL ONLY. Never run against production: it creates stub tables and an auth schema.
--
-- Exercises 0151_admin_audit_log_fk_set_null.sql on admin_audit_log exactly as 0069 creates it, in an EMPTY
-- database. Run from the repo root:
--
--   createdb audit_fk_test
--   psql -v ON_ERROR_STOP=1 -d audit_fk_test -f migrations/tests/0151_admin_audit_log_fk_set_null_local_test.sql
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
-- The tables 0149 adds (they cascade / set null themselves).
CREATE TABLE public.orders (id uuid);
\i migrations/0149_admin_user_notes_tags.sql

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000ad'),   -- admin who acted
  ('00000000-0000-0000-0000-00000000000a'),   -- a user who will be deleted
  ('00000000-0000-0000-0000-00000000000b');   -- a user who stays
INSERT INTO public.admin_audit_log (admin_id, action, target_user_id) VALUES
  ('00000000-0000-0000-0000-0000000000ad', 'user_notify', '00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-0000000000ad', 'user_notify', '00000000-0000-0000-0000-00000000000b');
INSERT INTO public.admin_user_notes (user_id, author_id, body) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000ad', 'n');
INSERT INTO public.admin_user_tags (user_id, tag) VALUES ('00000000-0000-0000-0000-00000000000a', 'vip');

-- Before 0151: an audited user cannot be deleted (this is what left remove-user half done).
DO $$ BEGIN
  BEGIN
    DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-00000000000a';
    RAISE EXCEPTION 'delete should have been blocked before 0151';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- An environment where the target FK carries another name (and a second, duplicate FK): 0151 finds them by
-- column, not by name.
ALTER TABLE public.admin_audit_log RENAME CONSTRAINT admin_audit_log_target_user_id_fkey TO some_old_name;
ALTER TABLE public.admin_audit_log ADD CONSTRAINT dup_target_fk FOREIGN KEY (target_user_id) REFERENCES auth.users(id);

\i migrations/0151_admin_audit_log_fk_set_null.sql
-- Idempotent: a second apply succeeds and changes nothing.
\i migrations/0151_admin_audit_log_fk_set_null.sql

DO $$
DECLARE
  n int;
BEGIN
  -- exactly one FK per column, both ON DELETE SET NULL, both validated, admin_id nullable
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.admin_audit_log'::regclass AND contype = 'f';
  ASSERT n = 2, format('two FKs, got %s', n);
  ASSERT (SELECT bool_and(confdeltype = 'n' AND convalidated AND confrelid = 'auth.users'::regclass)
            FROM pg_constraint WHERE conrelid = 'public.admin_audit_log'::regclass AND contype = 'f'), 'SET NULL, valid, auth.users';
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_audit_log_admin_id_fkey' AND conrelid = 'public.admin_audit_log'::regclass), 'admin fk name';
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_audit_log_target_user_id_fkey' AND conrelid = 'public.admin_audit_log'::regclass), 'target fk name';
  ASSERT (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid = 'public.admin_audit_log'::regclass AND attname = 'admin_id'), 'admin_id nullable';

  -- deleting an audited user now works: their audit rows stay, with target_user_id NULL; notes and tags go
  DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-00000000000a';
  ASSERT (SELECT count(*) FROM public.admin_audit_log) = 2, 'audit rows kept';
  ASSERT (SELECT count(*) FROM public.admin_audit_log WHERE target_user_id IS NULL) = 1, 'target set null';
  ASSERT NOT EXISTS (SELECT 1 FROM public.admin_user_notes), 'notes cascade';
  ASSERT NOT EXISTS (SELECT 1 FROM public.admin_user_tags), 'tags cascade';

  -- deleting the admin who acted keeps their rows with admin_id NULL
  DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-0000000000ad';
  ASSERT (SELECT count(*) FROM public.admin_audit_log WHERE admin_id IS NULL) = 2, 'admin set null';

  -- the FKs still refuse an unknown user on insert
  BEGIN
    INSERT INTO public.admin_audit_log (admin_id, action, target_user_id) VALUES (NULL, 'x', '00000000-0000-0000-0000-0000000000ff');
    RAISE EXCEPTION 'unknown target accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  RAISE NOTICE 'ADMIN_AUDIT_LOG_FK_LOCAL_TEST_OK';
END $$;
