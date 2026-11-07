-- 0159_hubtel_wallet_payments.sql
--
-- Wallet payment on the Hubtel main USSD code: a registered caller pays from their Datagod wallet instead of Hubtel's
-- checkout. One RPC debits the wallet and records the payment in one transaction.
-- ADDITIVE; service-role only. NOT applied by the implementing agent. Nothing calls the RPC until a later task.
-- One transaction. Idempotent (re-runnable).
--
--   hubtel_wallet_payments  one row per wallet-paid Hubtel session. session_id is unique, and so is (order_table,
--                           order_id). state: 'debited' -> 'fulfilled' or 'needs_review', moved by the caller after the
--                           post-payment handler runs. The partial index serves a sweep of rows stuck on 'debited'.
--                           RLS on, no policies: only the service role may touch it.
--   pay_hubtel_order_from_wallet(p_session, p_user, p_table, p_order, p_amount, p_source, p_description)
--     Signature (text, uuid, text, uuid, numeric, text, text).
--
-- The RPC does NOT touch the order row, on purpose. The existing post-payment handlers (createOrderHandlers) mark it
-- paid and deliver, and they return early on an order already completed.
--
-- RPC contract
--   p_session      Hubtel's session id, not blank.
--   p_user         the wallet's owner. The caller decides this from the dialling number.
--   p_table        one of ussd_orders, airtime_orders, results_checker_orders, results_check_requests.
--   p_order        the order's id. The RPC does not read the order: the caller created it just before this call and
--                  owns the price. p_amount is what is charged.
--   p_amount       > 0, at most 2 decimals, < 1,000,000 (which also refuses NaN and Infinity).
--   p_source       one of ussd_data_purchase, airtime_purchase, ussd_results_checker, results_check_request.
--   p_description  the wallet history text, not blank. It may carry a phone, so it never reaches an error.
--   returns        {"payment_id": uuid, "replay": bool, "new_balance": numeric}. On a replay, new_balance is the balance
--                  now, and the stored payment's amount stands whatever amount was passed.
--   errors         'BAD_INPUT' (reason in DETAIL), 'ALREADY_CARTED', 'INSUFFICIENT_FUNDS' (balance short, or no wallet
--                  row). All are fixed strings with no phone and no row data, and nothing is written on any of them.
--                  BAD_INPUT covers: a bad argument; a session already holding a payment for another order or user; an
--                  order already holding a payment; a debit already recorded for the order; any constraint refusing the
--                  write. Postgres's own error is never re-raised, because its DETAIL holds the failing row.
--
-- Order: guard session and user -> lock the wallet row (FOR UPDATE) -> replay lookup -> validate -> order already paid?
-- -> session already carted? -> deduct_wallet -> one transactions row -> one payment row.
--
-- Replay: only when the stored row names the same table, order and user. The same session with anything else is
-- BAD_INPUT, so a replay can never report another order or another user's payment as paid.
--
-- Money path mirrors create_special_bundle_orders (0141):
--   * deduct_wallet(user, amount) (0089: positivity guard; balance >= amount; balance and total_spent updated);
--   * ONE transactions row: type 'debit', the given source, amount, balance_before/after from deduct_wallet, status
--     'completed', reference_id = the order id as text. transaction_reference on the payment row stores that same value.
--   The transactions UNIQUE (user_id, reference_id, type) is keyed on the order id, so a second debit for one order
--   collides there as well, whatever its table. The whole money block rolls back and the caller gets BAD_INPUT.
--
-- Concurrency:
--   * Same user: both calls lock the wallet row first; the second waits, then (READ COMMITTED, fresh snapshot per
--     statement) sees the first call's committed row and returns the replay. Exactly one debit.
--   * Different users on one session or one order: no shared wallet lock. The loser blocks on the unique index until the
--     winner commits, gets unique_violation, and its debit rolls back. The handler returns the winner as a replay if it
--     is the same table, order and user; otherwise BAD_INPUT.
--   * The ALREADY_CARTED check is a read, not a lock: the checkout path does not take this wallet lock. Refusing the
--     other direction (never cart a session or order with a wallet payment) belongs to the checkout path.
--   * Lock order: wallet row, then new rows only. No deadlock cycle with data_order_debit (order row -> wallet).
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.hubtel_wallet_payments');                                    -- NULL
--   SELECT count(*) FROM pg_proc WHERE proname = 'pay_hubtel_order_from_wallet';            -- 0
--   SELECT count(*) FROM pg_proc WHERE proname = 'deduct_wallet' AND prosecdef;             -- 1
--   SELECT count(*) FROM pg_constraint WHERE conname = 'transactions_source_check';         -- 0
--     -- No migration in this repo creates it. If it exists in prod, read it: it must allow ussd_data_purchase,
--     -- airtime_purchase, ussd_results_checker and results_check_request. If it would refuse one, widen it in this
--     -- migration before applying. The self-test's every_table_and_source scenario fails on such a refusal.
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'unique_transaction_reference';
--     -- UNIQUE (user_id, reference_id, type)
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.transactions'::regclass AND contype = 'c';
--     -- any CHECK must allow type 'debit' and status 'completed'
--   SELECT table_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND column_name = 'id'
--      AND table_name IN ('ussd_orders','airtime_orders','results_checker_orders','results_check_requests');
--     -- 4 rows, all uuid (the self-test's order_id_types scenario checks this too)
--   SELECT data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'reference_id';
--     -- character varying or text, wide enough for a uuid
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.transactions'::regclass AND NOT tgisinternal;
--     -- anything here: read it before applying
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.wallets'::regclass AND NOT tgisinternal;
--     -- sec_detect_wallet_trg (0085); anything else: read it before applying
--
-- Self-test (self-rolling-back dry run): migrations/0159_hubtel_wallet_payments.selftest.sql
-- That run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement
-- (the 0130 incident lesson); lib/ussd-hubtel/wallet-migration.test.ts builds and checks it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. One row per wallet-paid session.
CREATE TABLE IF NOT EXISTS public.hubtel_wallet_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            text NOT NULL UNIQUE,
  order_table           text NOT NULL,
  order_id              uuid NOT NULL,
  user_id               uuid NOT NULL,
  amount                numeric(12,2) NOT NULL CHECK (amount > 0),
  state                 text NOT NULL DEFAULT 'debited' CHECK (state IN ('debited','fulfilled','needs_review')),
  review_reason         text,
  transaction_reference text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_table, order_id)
);

CREATE INDEX IF NOT EXISTS hubtel_wallet_payments_debited_idx
  ON public.hubtel_wallet_payments (created_at) WHERE state = 'debited';

ALTER TABLE public.hubtel_wallet_payments ENABLE ROW LEVEL SECURITY;
-- No policies on purpose. 0060 grants authenticated CRUD by default, so the REVOKE is what keeps it out.
REVOKE ALL ON TABLE public.hubtel_wallet_payments FROM PUBLIC, anon, authenticated;
-- Rows are inserted only by the RPC; the caller reads them and moves the state.
GRANT SELECT, UPDATE ON TABLE public.hubtel_wallet_payments TO service_role;

-- 2. Atomic debit + history row + payment row.
CREATE OR REPLACE FUNCTION public.pay_hubtel_order_from_wallet(
  p_session     text,
  p_user        uuid,
  p_table       text,
  p_order       uuid,
  p_amount      numeric,
  p_source      text,
  p_description text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_pay  public.hubtel_wallet_payments%ROWTYPE;
  v_id   uuid;
  d      record;
BEGIN
  -- 0. Guards needed before the lock and the replay lookup.
  IF p_session IS NULL OR btrim(p_session) = '' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'session required';
  END IF;
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'user required';
  END IF;

  -- 1. Lock the wallet row FIRST: a concurrent call for this user waits here, then sees the committed payment below.
  --    No row = no wallet; the debit reports that as INSUFFICIENT_FUNDS after validation.
  PERFORM 1 FROM public.wallets w WHERE w.user_id = p_user FOR UPDATE;

  -- 2. Replay: this session already paid for this order => hand it back, never debit again, whatever the amount.
  SELECT * INTO v_pay FROM public.hubtel_wallet_payments p WHERE p.session_id = p_session;
  IF FOUND THEN
    IF v_pay.order_table IS DISTINCT FROM p_table OR v_pay.order_id IS DISTINCT FROM p_order OR v_pay.user_id IS DISTINCT FROM p_user THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'session already holds another payment';
    END IF;
    RETURN jsonb_build_object(
      'payment_id', v_pay.id,
      'replay', true,
      'new_balance', (SELECT w.balance FROM public.wallets w WHERE w.user_id = p_user));
  END IF;

  -- 3. Validate everything.
  IF p_table IS NULL OR p_table NOT IN ('ussd_orders','airtime_orders','results_checker_orders','results_check_requests') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'order table not allowed';
  END IF;
  IF p_order IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'order required';
  END IF;
  IF p_amount IS NULL OR NOT (p_amount > 0) OR p_amount >= 1000000 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'amount must be positive with at most 2 decimals';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('ussd_data_purchase','airtime_purchase','ussd_results_checker','results_check_request') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'source not allowed';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'description required';
  END IF;

  -- 4. This order is already paid from a wallet, under another session (a same-session repeat returned above).
  IF EXISTS (SELECT 1 FROM public.hubtel_wallet_payments p WHERE p.order_table = p_table AND p.order_id = p_order) THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'order already holds a payment';
  END IF;

  -- 5. This session reached Hubtel's checkout: one order, one way to pay.
  IF EXISTS (SELECT 1 FROM public.hubtel_transactions h WHERE h.session_id = p_session) THEN
    RAISE EXCEPTION 'ALREADY_CARTED';
  END IF;

  -- 6. Money: one debit, one history row, one payment row. Any error here rolls all three back.
  <<money>>
  BEGIN
    SELECT * INTO d FROM public.deduct_wallet(p_user, p_amount);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
    END IF;

    INSERT INTO public.transactions (user_id, type, source, amount, balance_before, balance_after, description, reference_id, status, created_at)
    VALUES (p_user, 'debit', p_source, p_amount, d.old_balance, d.new_balance, p_description, p_order::text, 'completed', now());

    INSERT INTO public.hubtel_wallet_payments (session_id, order_table, order_id, user_id, amount, transaction_reference)
    VALUES (p_session, p_table, p_order, p_user, p_amount, p_order::text)
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('payment_id', v_id, 'replay', false, 'new_balance', d.new_balance);
  EXCEPTION
    WHEN unique_violation THEN
      -- The debit is rolled back. A race on the session (the same payment arriving twice) returns the winner. Any other
      -- clash gets a fixed error, never Postgres's own: its DETAIL shows the key values.
      SELECT * INTO v_pay FROM public.hubtel_wallet_payments p
       WHERE p.session_id = p_session AND p.order_table = p_table AND p.order_id = p_order AND p.user_id = p_user;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'order or session already paid';
      END IF;
      RETURN jsonb_build_object(
        'payment_id', v_pay.id,
        'replay', true,
        'new_balance', (SELECT w.balance FROM public.wallets w WHERE w.user_id = p_user));
    WHEN integrity_constraint_violation THEN
      -- The debit is rolled back. Postgres's DETAIL here is the failing row, which holds p_description.
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'a constraint refused the payment';
  END money;
END
$fn$;

REVOKE ALL ON FUNCTION public.pay_hubtel_order_from_wallet(text, uuid, text, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pay_hubtel_order_from_wallet(text, uuid, text, uuid, numeric, text, text) TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.hubtel_wallet_payments'::regclass;   -- true
--   SELECT count(*) FROM pg_policies WHERE tablename = 'hubtel_wallet_payments';                 -- 0
--   SELECT indexdef FROM pg_indexes WHERE tablename = 'hubtel_wallet_payments';
--     -- pkey, UNIQUE (session_id), UNIQUE (order_table, order_id), (created_at) WHERE state = 'debited'
--   SELECT p.prosecdef, p.proconfig FROM pg_proc p WHERE p.proname = 'pay_hubtel_order_from_wallet';
--     -- true, {search_path=public}
--   SELECT has_function_privilege('anon', 'public.pay_hubtel_order_from_wallet(text,uuid,text,uuid,numeric,text,text)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.pay_hubtel_order_from_wallet(text,uuid,text,uuid,numeric,text,text)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.pay_hubtel_order_from_wallet(text,uuid,text,uuid,numeric,text,text)', 'EXECUTE');
--     -- false, false, true
--   SELECT has_table_privilege('anon', 'public.hubtel_wallet_payments', 'SELECT'),
--          has_table_privilege('authenticated', 'public.hubtel_wallet_payments', 'SELECT'),
--          has_table_privilege('service_role', 'public.hubtel_wallet_payments', 'SELECT');
--     -- false, false, true
--   SELECT count(*) FROM hubtel_wallet_payments;                                                 -- 0 until the switch is on
