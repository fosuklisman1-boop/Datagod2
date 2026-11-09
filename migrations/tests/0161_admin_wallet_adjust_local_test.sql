-- LOCAL ONLY. Never run against production: it creates stub tables and an auth schema.
-- Renamed from 0146_admin_wallet_adjust_local_test.sql. The migration it tests was already applied to production on 2026-11-09 (as 0146_admin_wallet_adjust.sql).
--
-- Exercises 0161_admin_wallet_adjust.sql against a stub schema in an EMPTY database. Run from the repo root:
--
--   createdb wallet_adjust_test
--   psql -v ON_ERROR_STOP=1 -d wallet_adjust_test -f migrations/tests/0161_admin_wallet_adjust_local_test.sql
--
-- Passes when it prints ADMIN_WALLET_ADJUST_LOCAL_TEST_OK. Any failed ASSERT aborts.

\set ON_ERROR_STOP 1

DO $$ BEGIN
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), role varchar(20) DEFAULT 'user');
-- Columns as the app reads and writes them (lib, update-balance route, credit_wallet_safely, deduct_wallet).
CREATE TABLE public.wallets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, balance numeric(12,2) DEFAULT 0,
  total_credited numeric(12,2) DEFAULT 0, total_spent numeric(12,2) DEFAULT 0, updated_at timestamptz DEFAULT now());
CREATE TABLE public.transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, amount numeric(12,2),
  type text, status text, description text, reference_id text, source text, balance_before numeric(12,2),
  balance_after numeric(12,2), created_at timestamptz DEFAULT now());
-- As in 0069_admin_moderation_sms.sql.
CREATE TABLE public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES auth.users(id),
  action text NOT NULL,
  target_user_id uuid REFERENCES auth.users(id),
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000ad'), ('00000000-0000-0000-0000-0000000000ee'),
  ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003'), ('00000000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000005');
INSERT INTO public.users (id, role) VALUES
  ('00000000-0000-0000-0000-0000000000ad', 'admin'), ('00000000-0000-0000-0000-0000000000ee', 'dealer'),
  ('00000000-0000-0000-0000-000000000001', 'user');
INSERT INTO public.wallets (user_id, balance, total_credited, total_spent) VALUES
  ('00000000-0000-0000-0000-0000000000ad', 3.00, 0, 0),
  ('00000000-0000-0000-0000-000000000001', 10.00, 100, 40),
  ('00000000-0000-0000-0000-000000000003', 1.00, 0, 0),
  ('00000000-0000-0000-0000-000000000003', 1.00, 0, 0),
  ('00000000-0000-0000-0000-000000000004', -2.00, 0, 0),
  ('00000000-0000-0000-0000-000000000005', 7.00, 0, 0);

-- Applied twice: the migration must be re-runnable.
\i migrations/0161_admin_wallet_adjust.sql
\i migrations/0161_admin_wallet_adjust.sql

DO $$
DECLARE
  A  constant uuid := '00000000-0000-0000-0000-0000000000ad';  -- admin
  N  constant uuid := '00000000-0000-0000-0000-0000000000ee';  -- not an admin
  U  constant uuid := '00000000-0000-0000-0000-000000000001';  -- wallet 10.00
  W0 constant uuid := '00000000-0000-0000-0000-000000000002';  -- no wallet
  W2 constant uuid := '00000000-0000-0000-0000-000000000003';  -- two wallet rows
  r  jsonb;
  v_n int;
  v_bal numeric;
  v_err text;
  v_detail text;
  t  record;
  al record;
BEGIN
  -- ── credit ──────────────────────────────────────────────────────────────
  r := public.admin_wallet_adjust(A, U, 'credit', 5.25, '  refund for failed order  ');
  ASSERT (r->>'balance_before')::numeric = 10.00, r::text;
  ASSERT (r->>'balance_after')::numeric = 15.25, r::text;
  ASSERT r->>'type' = 'credit' AND (r->>'amount')::numeric = 5.25, r::text;
  ASSERT r->>'reference_id' ~ '^ADMIN_CREDIT_[0-9a-f]{32}$', r->>'reference_id';
  SELECT balance, total_credited, total_spent INTO t FROM public.wallets WHERE user_id = U;
  ASSERT t.balance = 15.25 AND t.total_credited = 105.25 AND t.total_spent = 40, t::text;

  SELECT * INTO t FROM public.transactions WHERE id = (r->>'transaction_id')::uuid;
  ASSERT t.user_id = U AND t.type = 'admin_credit' AND t.status = 'completed' AND t.source = 'admin_operation', t::text;
  ASSERT t.amount = 5.25 AND t.balance_before = 10.00 AND t.balance_after = 15.25, t::text;
  ASSERT t.reference_id = r->>'reference_id', t::text;
  ASSERT t.description = 'Admin credited GHS 5.25: refund for failed order', t.description;

  SELECT * INTO al FROM public.admin_audit_log WHERE target_user_id = U ORDER BY created_at DESC, id DESC LIMIT 1;
  ASSERT al.admin_id = A AND al.action = 'wallet_credit', al::text;
  ASSERT al.old_value = jsonb_build_object('balance', 10.00), al.old_value::text;
  ASSERT (al.new_value->>'balance')::numeric = 15.25 AND (al.new_value->>'amount')::numeric = 5.25, al.new_value::text;
  ASSERT al.new_value->>'reason' = 'refund for failed order' AND al.new_value->>'type' = 'credit', al.new_value::text;
  ASSERT al.new_value->>'transaction_id' = r->>'transaction_id', al.new_value::text;

  -- ── debit (exactly to zero is allowed) ─────────────────────────────────
  r := public.admin_wallet_adjust(A, U, 'debit', 15.25, 'chargeback reversal', 15.25);
  ASSERT (r->>'balance_before')::numeric = 15.25 AND (r->>'balance_after')::numeric = 0, r::text;
  SELECT balance, total_credited, total_spent INTO t FROM public.wallets WHERE user_id = U;
  ASSERT t.balance = 0 AND t.total_credited = 105.25 AND t.total_spent = 55.25, t::text;
  SELECT * INTO t FROM public.transactions WHERE id = (r->>'transaction_id')::uuid;
  ASSERT t.type = 'admin_debit' AND t.amount = 15.25 AND t.balance_before = 15.25 AND t.balance_after = 0, t::text;
  ASSERT r->>'reference_id' ~ '^ADMIN_DEBIT_', r::text;
  SELECT * INTO al FROM public.admin_audit_log WHERE new_value->>'transaction_id' = r->>'transaction_id';
  ASSERT al.action = 'wallet_debit' AND al.admin_id = A, al::text;

  SELECT count(*) INTO v_n FROM public.transactions WHERE user_id = U;
  ASSERT v_n = 2, v_n;
  SELECT count(*) INTO v_n FROM public.admin_audit_log WHERE target_user_id = U;
  ASSERT v_n = 2, v_n;

  -- ── refusals: each writes nothing ───────────────────────────────────────
  FOR t IN
    SELECT * FROM (VALUES
      ('overdraft',        A, U,  'debit',  0.01::numeric,  'too much please', NULL::numeric, 'INSUFFICIENT_BALANCE'),
      ('stale balance',    A, U,  'credit', 1,              'stale confirm',   99,            'BALANCE_CHANGED'),
      ('not admin',        N, U,  'credit', 1,              'not an admin',    NULL,          'NOT_ADMIN'),
      ('unknown admin',    '00000000-0000-0000-0000-0000000000ff'::uuid, U, 'credit', 1, 'ghost admin', NULL, 'NOT_ADMIN'),
      ('no wallet',        A, W0, 'credit', 1,              'no wallet here',  NULL,          'WALLET_NOT_FOUND'),
      ('two wallets',      A, W2, 'credit', 1,              'two wallets',     NULL,          'AMBIGUOUS_WALLET'),
      ('zero amount',      A, U,  'credit', 0,              'zero amount',     NULL,          'BAD_INPUT'),
      ('negative amount',  A, U,  'credit', -1,             'negative',        NULL,          'BAD_INPUT'),
      ('three decimals',   A, U,  'credit', 1.005,          'three decimals',  NULL,          'BAD_INPUT'),
      ('over cap',         A, U,  'credit', 50000.01,       'over the cap',    NULL,          'BAD_INPUT'),
      ('null amount',      A, U,  'credit', NULL,           'null amount',     NULL,          'BAD_INPUT'),
      ('bad type',         A, U,  'refund', 1,              'bad type here',   NULL,          'BAD_INPUT'),
      ('short reason',     A, U,  'credit', 1,              ' abcd ',          NULL,          'BAD_INPUT'),
      ('null reason',      A, U,  'credit', 1,              NULL,              NULL,          'BAD_INPUT'),
      ('long reason',      A, U,  'credit', 1,              repeat('x', 501),  NULL,          'BAD_INPUT'),
      ('null admin',       NULL, U, 'credit', 1,            'null admin',      NULL,          'BAD_INPUT'),
      ('own wallet',       A, A,  'credit', 1,              'pay myself',      NULL,          'SELF_ADJUST')
    ) AS c(label, admin_id, user_id, typ, amount, reason, expected, code)
  LOOP
    v_err := NULL;
    BEGIN
      PERFORM public.admin_wallet_adjust(t.admin_id, t.user_id, t.typ, t.amount, t.reason, t.expected);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    ASSERT v_err = t.code, format('%s: expected %s, got %s', t.label, t.code, coalesce(v_err, 'no error'));
  END LOOP;

  -- Debit of a negative (legacy) balance is refused; credit of it works.
  BEGIN
    PERFORM public.admin_wallet_adjust(A, '00000000-0000-0000-0000-000000000004', 'debit', 1, 'legacy negative');
    RAISE EXCEPTION 'expected INSUFFICIENT_BALANCE';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    ASSERT SQLERRM = 'INSUFFICIENT_BALANCE', SQLERRM;
  END;
  r := public.admin_wallet_adjust(A, '00000000-0000-0000-0000-000000000004', 'credit', 2.5, 'top up negative');
  ASSERT (r->>'balance_after')::numeric = 0.5, r::text;

  SELECT balance INTO v_bal FROM public.wallets WHERE user_id = U;
  ASSERT v_bal = 0, v_bal;
  SELECT count(*) INTO v_n FROM public.transactions WHERE user_id = U;
  ASSERT v_n = 2, format('refusals wrote transactions: %s', v_n);
  SELECT count(*) INTO v_n FROM public.admin_audit_log WHERE target_user_id IN (U, W0, W2);
  ASSERT v_n = 2, format('refusals wrote audit rows: %s', v_n);
  SELECT count(*) INTO v_n FROM public.wallets WHERE user_id = W2 AND balance <> 1;
  ASSERT v_n = 0, 'ambiguous wallets changed';
  SELECT count(*) INTO v_n FROM public.wallets WHERE user_id = A AND balance <> 3;
  ASSERT v_n = 0, 'admin adjusted own wallet';

  -- ── grants and definition ──────────────────────────────────────────────
  ASSERT NOT has_function_privilege('anon',          'public.admin_wallet_adjust(uuid,uuid,text,numeric,text,numeric)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_wallet_adjust(uuid,uuid,text,numeric,text,numeric)', 'EXECUTE');
  ASSERT has_function_privilege('service_role',      'public.admin_wallet_adjust(uuid,uuid,text,numeric,text,numeric)', 'EXECUTE');
  ASSERT (SELECT prosecdef FROM pg_proc WHERE proname = 'admin_wallet_adjust'), 'not SECURITY DEFINER';
  ASSERT (SELECT proconfig FROM pg_proc WHERE proname = 'admin_wallet_adjust') = ARRAY['search_path=public, pg_temp'],
    (SELECT proconfig FROM pg_proc WHERE proname = 'admin_wallet_adjust')::text;
END $$;

-- Atomicity: if the audit insert fails, the wallet update and the transactions row roll back with it.
ALTER TABLE public.admin_audit_log ADD CONSTRAINT test_block_audit CHECK (action <> 'wallet_credit') NOT VALID;
DO $$
DECLARE
  U constant uuid := '00000000-0000-0000-0000-000000000005';
  v_err text;
  v_n int;
  v_bal numeric;
BEGIN
  BEGIN
    PERFORM public.admin_wallet_adjust('00000000-0000-0000-0000-0000000000ad', U, 'credit', 3, 'audit will fail');
  EXCEPTION WHEN check_violation THEN
    v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'expected the audit insert to fail';
  SELECT balance INTO v_bal FROM public.wallets WHERE user_id = U;
  ASSERT v_bal = 7, format('wallet changed despite failed audit: %s', v_bal);
  SELECT count(*) INTO v_n FROM public.transactions WHERE user_id = U;
  ASSERT v_n = 0, 'transaction written despite failed audit';
END $$;
ALTER TABLE public.admin_audit_log DROP CONSTRAINT test_block_audit;

-- Service role can call it (as in production, via PostgREST).
SET ROLE service_role;
SELECT (public.admin_wallet_adjust('00000000-0000-0000-0000-0000000000ad', '00000000-0000-0000-0000-000000000005',
        'credit', 1, 'as service role'))->>'balance_after' AS service_role_balance_after;
RESET ROLE;

-- authenticated cannot.
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.admin_wallet_adjust('00000000-0000-0000-0000-0000000000ad', '00000000-0000-0000-0000-000000000005',
          'credit', 1, 'as authenticated');
  RAISE EXCEPTION 'authenticated was able to call admin_wallet_adjust';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
RESET ROLE;

SELECT 'ADMIN_WALLET_ADJUST_LOCAL_TEST_OK' AS result;
