-- LOCAL ONLY. Never run against production: it creates stub tables and an auth schema.
-- Renamed from 0149_admin_user_notes_tags_local_test.sql. The migration it tests was already applied to production on 2026-11-09 (as 0149_admin_user_notes_tags.sql).
--
-- Exercises 0174_admin_user_notes_tags.sql (and 0175's index) against a stub schema in an EMPTY database, with
-- fixtures whose expected results are worked out by hand. Run from the repo root:
--
--   createdb notes_tags_test
--   psql -v ON_ERROR_STOP=1 -d notes_tags_test -f migrations/tests/0174_admin_user_notes_tags_local_test.sql
--
-- Passes when it prints ADMIN_USER_NOTES_TAGS_LOCAL_TEST_OK. Any failed ASSERT aborts.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, created_at timestamptz);
CREATE TABLE public.users (id uuid PRIMARY KEY, phone_number varchar(20), phone_verified boolean NOT NULL DEFAULT false);
CREATE INDEX idx_users_phone_number ON public.users (phone_number);
CREATE TABLE public.wallets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, balance numeric(12,2));
CREATE TABLE public.transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, amount numeric(12,2),
  type text, status text, source text, created_at timestamptz DEFAULT now());
CREATE TABLE public.admin_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid NOT NULL REFERENCES auth.users(id),
  action text NOT NULL, target_user_id uuid REFERENCES auth.users(id), old_value jsonb, new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
-- The 7 order tables admin_user_orders (0172) reads; orders.created_at is timestamp without time zone, as in some environments.
CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status varchar(50), created_at timestamp);
CREATE TABLE public.api_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz);
CREATE TABLE public.hubtel_data_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz);
CREATE TABLE public.airtime_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz);
CREATE TABLE public.hubtel_bill_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz);
CREATE TABLE public.results_checker_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, created_at timestamptz);
CREATE TABLE public.afa_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status varchar(50), created_at timestamptz);

\i migrations/0174_admin_user_notes_tags.sql
-- Idempotent: a second apply succeeds.
\i migrations/0174_admin_user_notes_tags.sql
\i migrations/0175_admin_user_signals_indexes.sql
\i migrations/0175_admin_user_signals_indexes.sql

-- A: busy, risky account: new (2h old), 600 in the wallet, 7 failed orders today across tables (incl. a cancelled
--    AFA order; +1 older, +1 completed, +1 cancelled data order), 3 refunds this week (+1 older; clawbacks,
--    debits and a type 'refund' row are not refunds), 1 admin credit of 250 today (+1 older), phone 0244111222 shared
--    with B (stored 233244111222) and C (stored 244111222); verified.
-- B: old account, quiet; one completed api order last month.
-- D: no users row, no wallet, nothing.
-- X: an admin (the audit author).
INSERT INTO auth.users (id, email, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'a@x.com', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000000b', 'b@x.com', now() - interval '400 days'),
  ('00000000-0000-0000-0000-00000000000c', 'c@x.com', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000000d', 'd@x.com', now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000000ad', 'x@x.com', now() - interval '900 days');
INSERT INTO public.users (id, phone_number, phone_verified) VALUES
  ('00000000-0000-0000-0000-00000000000a', '0244111222', true),
  ('00000000-0000-0000-0000-00000000000b', '233244111222', false),
  ('00000000-0000-0000-0000-00000000000c', '244111222', false),
  ('00000000-0000-0000-0000-0000000000ad', '12345', false);
INSERT INTO public.wallets (user_id, balance) VALUES
  ('00000000-0000-0000-0000-00000000000a', 600), ('00000000-0000-0000-0000-00000000000b', 5),
  ('00000000-0000-0000-0000-00000000000b', 7);
INSERT INTO public.orders (user_id, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'failed',    (now() - interval '1 hour')::timestamp),
  ('00000000-0000-0000-0000-00000000000a', 'FAILED',    (now() - interval '2 hours')::timestamp),
  ('00000000-0000-0000-0000-00000000000a', 'failed',    (now() - interval '30 hours')::timestamp),
  ('00000000-0000-0000-0000-00000000000a', 'completed', (now() - interval '10 minutes')::timestamp);
INSERT INTO public.api_orders (user_id, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'error',  now() - interval '3 hours'),
  ('00000000-0000-0000-0000-00000000000b', 'completed', '2026-01-15 12:00+00');
INSERT INTO public.hubtel_data_orders (user_id, status, created_at) VALUES ('00000000-0000-0000-0000-00000000000a', 'failed', now() - interval '4 hours');
INSERT INTO public.airtime_orders (user_id, status, created_at) VALUES ('00000000-0000-0000-0000-00000000000a', 'failed', now() - interval '5 hours');
INSERT INTO public.hubtel_bill_orders (user_id, status, created_at) VALUES ('00000000-0000-0000-0000-00000000000a', 'failed', now() - interval '6 hours');
INSERT INTO public.results_checker_orders (user_id, status, created_at) VALUES ('00000000-0000-0000-0000-00000000000a', 'pending', now() - interval '7 hours');
INSERT INTO public.afa_orders (user_id, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'completed', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-00000000000a', 'cancelled', now() - interval '2 hours');
-- 'cancelled' is a failure only for AFA; in the other tables it is not counted.
INSERT INTO public.orders (user_id, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'cancelled', (now() - interval '3 hours')::timestamp);
-- Refund credits as credit_wallet_safely and the airtime routes write them (type 'credit', a *_refund source).
-- No code writes type 'refund' / 'order_refund' transactions; such rows are not refunds here.
INSERT INTO public.transactions (user_id, type, source, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'credit', 'airtime_refund',         now() - interval '1 day'),
  ('00000000-0000-0000-0000-00000000000a', 'credit', 'order_refund',           now() - interval '2 days'),
  ('00000000-0000-0000-0000-00000000000a', 'credit', 'bill_refund',            now() - interval '6 days'),
  ('00000000-0000-0000-0000-00000000000a', 'credit', 'standard_bundle_refund', now() - interval '8 days'),
  ('00000000-0000-0000-0000-00000000000a', 'debit',  'data_purchase',          now() - interval '1 day'),
  -- clawbacks taken from (and given back to) shop owners when a storefront order is refunded: not refunds
  ('00000000-0000-0000-0000-00000000000a', 'debit',  'refund_clawback',        now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000000a', 'credit', 'refund_clawback_undo',   now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000000a', 'debit',  'order_refund',           now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000000a', 'refund', NULL,                     now() - interval '1 hour');
INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, new_value, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000ad', 'wallet_credit', '00000000-0000-0000-0000-00000000000a', '{"amount": 250}', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000000ad', 'wallet_credit', '00000000-0000-0000-0000-00000000000a', '{"amount": 99}',  now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000000ad', 'wallet_debit',  '00000000-0000-0000-0000-00000000000a', '{"amount": 5}',   now() - interval '1 hour');

DO $$
DECLARE
  v jsonb;
  a jsonb;
  msg text;
  i int;
BEGIN
  -- structure: RLS on, no policies, nothing for anon / authenticated, everything for service_role
  ASSERT (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.admin_user_notes'::regclass, 'public.admin_user_tags'::regclass)), 'RLS on';
  ASSERT (SELECT count(*) FROM pg_policies WHERE tablename IN ('admin_user_notes', 'admin_user_tags')) = 0, 'no policies';
  ASSERT NOT has_table_privilege('authenticated', 'public.admin_user_notes', 'SELECT'), 'authenticated notes';
  ASSERT NOT has_table_privilege('anon', 'public.admin_user_notes', 'SELECT'), 'anon notes';
  ASSERT NOT has_table_privilege('authenticated', 'public.admin_user_tags', 'INSERT'), 'authenticated tags';
  ASSERT has_table_privilege('service_role', 'public.admin_user_notes', 'INSERT'), 'service_role notes';
  ASSERT has_table_privilege('service_role', 'public.admin_user_tags', 'DELETE'), 'service_role tags';
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_user_signals(uuid[],int,int,int)', 'EXECUTE'), 'authenticated signals';
  ASSERT NOT has_function_privilege('anon', 'public.admin_user_signals(uuid[],int,int,int)', 'EXECUTE'), 'anon signals';
  ASSERT has_function_privilege('service_role', 'public.admin_user_signals(uuid[],int,int,int)', 'EXECUTE'), 'service_role signals';
  ASSERT (SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_admin_user_notes_user', 'idx_admin_user_tags_tag', 'idx_transactions_user_created_at')) = 3, 'indexes';
  ASSERT (SELECT indexdef FROM pg_indexes WHERE indexname = 'admin_user_tags_pkey') LIKE '%(user_id, tag)%', 'tags pk (user_id, tag)';

  -- notes: body 1..2000, author survives as NULL, notes go with the user
  INSERT INTO public.admin_user_notes (user_id, author_id, body) VALUES ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000ad', 'called about refund');
  INSERT INTO public.admin_user_notes (user_id, author_id, body) VALUES ('00000000-0000-0000-0000-00000000000b', NULL, repeat('x', 2000));
  BEGIN
    INSERT INTO public.admin_user_notes (user_id, body) VALUES ('00000000-0000-0000-0000-00000000000b', '');
    RAISE EXCEPTION 'empty note accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.admin_user_notes (user_id, body) VALUES ('00000000-0000-0000-0000-00000000000b', repeat('x', 2001));
    RAISE EXCEPTION 'long note accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.admin_user_notes (user_id, body) VALUES ('00000000-0000-0000-0000-0000000000ff', 'no such user');
    RAISE EXCEPTION 'note for a missing user accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;

  -- tags: [a-z0-9-]{1,32}, one row per (user, tag)
  INSERT INTO public.admin_user_tags (user_id, tag) VALUES ('00000000-0000-0000-0000-00000000000b', 'vip'), ('00000000-0000-0000-0000-00000000000b', 'bulk-buyer-2');
  INSERT INTO public.admin_user_tags (user_id, tag) VALUES ('00000000-0000-0000-0000-00000000000b', repeat('a', 32));
  FOREACH msg IN ARRAY ARRAY['VIP', '', 'has space', 'under_score', repeat('a', 33), 'émoji'] LOOP
    BEGIN
      INSERT INTO public.admin_user_tags (user_id, tag) VALUES ('00000000-0000-0000-0000-00000000000b', msg);
      RAISE EXCEPTION 'bad tag accepted: %', msg;
    EXCEPTION WHEN check_violation THEN NULL; END;
  END LOOP;
  BEGIN
    INSERT INTO public.admin_user_tags (user_id, tag) VALUES ('00000000-0000-0000-0000-00000000000b', 'vip');
    RAISE EXCEPTION 'duplicate tag accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- signals for A, B, C, D (and NULL / duplicate ids, which are ignored)
  v := public.admin_user_signals(ARRAY['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b',
    '00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000d', NULL, '00000000-0000-0000-0000-00000000000a']::uuid[]);
  ASSERT (SELECT count(*) FROM jsonb_object_keys(v)) = 4, format('4 users: %s', v);
  a := v->'00000000-0000-0000-0000-00000000000a';
  ASSERT (a->>'failed_orders')::int = 7, format('A failed (6 failed/error + 1 cancelled AFA): %s', a);
  ASSERT (a->>'refunds')::int = 3, format('A refunds: %s', a);
  ASSERT (a->>'admin_credits')::int = 1 AND (a->>'admin_credit_amount')::numeric = 250, format('A credits: %s', a);
  ASSERT (a->>'wallet_balance')::numeric = 600, format('A wallet: %s', a);
  ASSERT (a->>'phone_verified')::boolean AND a->>'phone_number' = '0244111222', format('A phone: %s', a);
  ASSERT (a->>'same_phone_accounts')::int = 3, format('A same phone: %s', a);
  ASSERT now() - (a->>'created_at')::timestamptz BETWEEN interval '119 minutes' AND interval '121 minutes', format('A created: %s', a);
  ASSERT now() - (a->>'last_order_at')::timestamptz < interval '2 minutes', format('A last order (afa, 1 minute ago): %s', a);

  a := v->'00000000-0000-0000-0000-00000000000b';
  ASSERT (a->>'last_order_at')::timestamptz = '2026-01-15 12:00+00', format('B last order: %s', a);
  ASSERT (a->>'failed_orders')::int = 0 AND (a->>'refunds')::int = 0 AND (a->>'admin_credits')::int = 0, format('B quiet: %s', a);
  ASSERT (a->>'wallet_balance')::numeric = 7 AND NOT (a->>'phone_verified')::boolean, format('B: %s', a);
  ASSERT (a->>'same_phone_accounts')::int = 3, format('B same phone (233 form): %s', a);
  ASSERT ((v->'00000000-0000-0000-0000-00000000000c')->>'same_phone_accounts')::int = 3, 'C same phone (bare form)';

  a := v->'00000000-0000-0000-0000-00000000000d';
  ASSERT a->'last_order_at' = 'null'::jsonb AND a->'phone_number' = 'null'::jsonb, format('D: %s', a);
  ASSERT (a->>'wallet_balance')::numeric = 0 AND (a->>'same_phone_accounts')::int = 0 AND NOT (a->>'phone_verified')::boolean, format('D: %s', a);

  -- a non-Ghana number matches exactly
  ASSERT ((public.admin_user_signals(ARRAY['00000000-0000-0000-0000-0000000000ad']::uuid[]))->'00000000-0000-0000-0000-0000000000ad'->>'same_phone_accounts')::int = 1, 'exact match';

  -- windows come from the caller (hours): 48h failed window also counts the 30h-old failure; 10-day refunds window the 8-day one
  a := public.admin_user_signals(ARRAY['00000000-0000-0000-0000-00000000000a']::uuid[], 48, 240, 96)->'00000000-0000-0000-0000-00000000000a';
  ASSERT (a->>'failed_orders')::int = 8 AND (a->>'refunds')::int = 4 AND (a->>'admin_credits')::int = 2, format('wider windows: %s', a);

  -- caps: 60 failed orders in one table count as 50
  INSERT INTO public.api_orders (user_id, status, created_at)
    SELECT '00000000-0000-0000-0000-00000000000b', 'failed', now() - interval '1 hour' FROM generate_series(1, 60);
  ASSERT ((public.admin_user_signals(ARRAY['00000000-0000-0000-0000-00000000000b']::uuid[]))->'00000000-0000-0000-0000-00000000000b'->>'failed_orders')::int = 50, 'cap 50';

  -- empty input, too many ids, NULL array
  ASSERT public.admin_user_signals(ARRAY[]::uuid[]) = '{}'::jsonb, 'empty';
  ASSERT public.admin_user_signals(ARRAY[NULL]::uuid[]) = '{}'::jsonb, 'only NULL';
  ASSERT (SELECT count(*) FROM jsonb_object_keys(public.admin_user_signals((SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 200))))) = 200, '200 ok';
  BEGIN
    PERFORM public.admin_user_signals((SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 201)));
    RAISE EXCEPTION '201 ids accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'BAD_INPUT', msg;
  END;
  BEGIN
    PERFORM public.admin_user_signals(NULL);
    RAISE EXCEPTION 'NULL accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'BAD_INPUT', msg;
  END;

  -- deleting a user removes their notes and tags; deleting an author keeps the note with author_id NULL
  DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-00000000000d';
  INSERT INTO auth.users (id, created_at) VALUES ('00000000-0000-0000-0000-0000000000ee', now());
  INSERT INTO public.admin_user_notes (user_id, author_id, body) VALUES ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000ee', 'by ee');
  INSERT INTO public.admin_user_tags (user_id, tag, created_by) VALUES ('00000000-0000-0000-0000-00000000000c', 'reseller', '00000000-0000-0000-0000-0000000000ee');
  DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-0000000000ee';
  ASSERT (SELECT author_id IS NULL FROM public.admin_user_notes WHERE body = 'by ee'), 'author set null';
  ASSERT (SELECT created_by IS NULL FROM public.admin_user_tags WHERE tag = 'reseller'), 'tag creator set null';
  DELETE FROM public.admin_audit_log;  -- (audit FKs have no cascade, as in production)
  DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-00000000000b';
  ASSERT NOT EXISTS (SELECT 1 FROM public.admin_user_notes WHERE user_id = '00000000-0000-0000-0000-00000000000b'), 'notes cascade';
  ASSERT NOT EXISTS (SELECT 1 FROM public.admin_user_tags WHERE user_id = '00000000-0000-0000-0000-00000000000b'), 'tags cascade';

  RAISE NOTICE 'ADMIN_USER_NOTES_TAGS_LOCAL_TEST_OK';
END $$;
