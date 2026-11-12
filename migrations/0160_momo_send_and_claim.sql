-- 0160_momo_send_and_claim.sql
--
-- Send & Claim: a customer sends MoMo to Datagod's number, then claims the credit with the MoMo transaction id (or a
-- session code). Spec and plan: docs/ (momo-claim). This file holds the TABLES and default SETTINGS. The money functions
-- (SECURITY DEFINER, service_role only) are added to this same file by the next task, after the tables and before COMMIT.
-- ADDITIVE; service-role only. NOT applied by the implementing agent. Nothing reads these tables until a later task.
-- One transaction. Idempotent (re-runnable).
--
--   wallet_topup_sessions     a code the customer gets before paying: amount, fee, net credit, expiry. Created first,
--                             because momo_transactions.session_id references it. Deleting the auth user deletes their
--                             sessions (ON DELETE CASCADE); a MoMo row is never deleted with them, only unlinked
--                             (session_id ON DELETE SET NULL), so the payment record survives.
--   momo_transactions         one row per MoMo SMS received. transaction_id is unique and is the MoMo id (8-15 digits).
--                             A row with no parsed id (unparsed, rejected sender) gets the synthetic id 'X' || uuid. That
--                             id is kept for life: an admin can credit an unparsed row later, so the CHECK does not look
--                             at status. Status: pending -> claimed | flagged | voided; unparsed / rejected_sender are
--                             parked.
--   momo_claim_attempts       one row per claim attempt, for rate limits and review. Early rejections use
--                             transaction_id = 'NOSESSION'. Written only by the SECURITY DEFINER functions.
--   momo_reconciliation_runs  one row per admin statement reconciliation.
--
-- All four: RLS on, no policies. 0060 grants authenticated CRUD by default, so the REVOKE is what keeps it out; it also
-- takes service_role's default ALL back. Nobody gets DELETE.
--   service_role: momo_transactions SELECT, INSERT, UPDATE; wallet_topup_sessions SELECT, INSERT, UPDATE;
--                 momo_claim_attempts SELECT; momo_reconciliation_runs SELECT, INSERT.
--
-- Default admin_settings rows (value JSONB as {"value": x}; amounts are GHS as JSON numbers, app code converts to pesewas).
-- ON CONFLICT (key) DO NOTHING, so a re-run never overwrites an admin's change. The feature ships OFF.
--
-- Section 7 adds the money functions: claim_momo_via_session (claim box), claim_via_wallet_topup_session (webhook),
-- admin_credit_momo_transaction, admin_unflag_momo_transaction (service_role), and the internal claim_momo_transaction,
-- momo_credit_wallet, momo_claim_fee, momo_setting_numeric (nobody). See the comment block at section 7.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.momo_transactions'), to_regclass('public.wallet_topup_sessions'),
--          to_regclass('public.momo_claim_attempts'), to_regclass('public.momo_reconciliation_runs');   -- all NULL
--   SELECT count(*) FROM admin_settings WHERE key LIKE 'momo\_%';                                        -- 0
--   SELECT data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'admin_settings' AND column_name = 'value';          -- jsonb
--   SELECT count(*) FROM pg_proc WHERE proname IN ('claim_momo_transaction','claim_via_wallet_topup_session','claim_momo_via_session',
--     'admin_credit_momo_transaction','admin_unflag_momo_transaction','momo_credit_wallet','momo_claim_fee','momo_setting_numeric'); -- 0
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'wallets' AND column_name IN ('balance','total_credited','updated_at');  -- 3 rows
--   SELECT count(*) FROM pg_constraint WHERE conname = 'transactions_source_check';   -- 0 (nothing refuses source 'momo_claim')
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.transactions'::regclass AND contype = 'c';               -- any CHECK allows type 'credit', status 'completed'
--   SELECT count(*) FROM transactions WHERE reference_id LIKE 'MOMO-%';                -- 0 (the self-test needs this)
--   SELECT count(*) FROM users WHERE role = 'dealer';                                  -- >= 1 (the self-test reads one)
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'unique_transaction_reference';
--     -- UNIQUE (user_id, reference_id, type): momo_credit_wallet's ledger check (user_id, reference_id, type 'credit') uses it
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.wallets'::regclass AND NOT tgisinternal;
--     -- sec_detect_wallet_trg (0085); anything else: read it before applying
--
-- Self-test (self-rolling-back dry run): migrations/0160_momo_send_and_claim.selftest.sql
-- That run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement
-- (the 0130 incident lesson); lib/momo-claim/migration.test.ts builds and checks it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Sessions. Before momo_transactions, which references this table.
CREATE TABLE IF NOT EXISTS public.wallet_topup_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[A-HJKMNP-Z]{3}[2-9]{4}$'),
  amount                numeric(12,2) NOT NULL CHECK (amount > 0),
  fee                   numeric(12,2) NOT NULL,
  net_amount            numeric(12,2) NOT NULL,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','expired','cancelled')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  claimed_transaction_id text,
  force_expired_by      uuid
);

CREATE INDEX IF NOT EXISTS wallet_topup_sessions_user_status_expires_idx
  ON public.wallet_topup_sessions (user_id, status, expires_at);

-- 2. One row per MoMo SMS.
CREATE TABLE IF NOT EXISTS public.momo_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      text NOT NULL UNIQUE CHECK (transaction_id ~ '^[0-9]{8,15}$' OR transaction_id ~ '^X[0-9a-f-]{36}$'),
  network             text,
  pattern             text,
  amount              numeric(12,2),
  sender_name         text,
  sms_sender          text,
  sms_balance         numeric(12,2),
  raw_sms             text NOT NULL,
  status              text NOT NULL CHECK (status IN ('pending','claimed','flagged','voided','unparsed','rejected_sender')),
  flag_reasons        text[] NOT NULL DEFAULT '{}',
  session_id          uuid REFERENCES public.wallet_topup_sessions(id) ON DELETE SET NULL,
  claimed_by          uuid,
  claimed_at          timestamptz,
  fee                 numeric(12,2),
  net_amount          numeric(12,2),
  credited_by_admin   uuid,
  admin_reason        text,
  unflagged_by        uuid,
  unflagged_at        timestamptz,
  unflag_reason       text,
  attempts_reset_at   timestamptz NOT NULL DEFAULT now(),
  received_at         timestamptz NOT NULL DEFAULT now()
);

-- 3. Claim attempts.
CREATE TABLE IF NOT EXISTS public.momo_claim_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  transaction_id  text NOT NULL,
  result          text NOT NULL CHECK (result IN ('credited','under_review','already_credited','not_matched','no_session','rate_limited','daily_limit','feature_off')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS momo_claim_attempts_user_created_idx
  ON public.momo_claim_attempts (user_id, created_at);
CREATE INDEX IF NOT EXISTS momo_claim_attempts_txid_created_idx
  ON public.momo_claim_attempts (transaction_id, created_at);

-- 4. Reconciliation runs.
CREATE TABLE IF NOT EXISTS public.momo_reconciliation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id         uuid NOT NULL,
  period_start     date,
  period_end       date,
  statement_txids  int,
  claimed_checked  int,
  missing_txids    text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz DEFAULT now()
);

-- 5. Lock the tables down. No policies on purpose.
ALTER TABLE public.wallet_topup_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.momo_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.momo_claim_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.momo_reconciliation_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.momo_transactions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.wallet_topup_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.momo_claim_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.momo_reconciliation_runs FROM PUBLIC, anon, authenticated;

-- 0060's default privileges give service_role ALL on a new table, so take it back, then grant only what is used.
REVOKE ALL ON TABLE public.momo_transactions FROM service_role;
REVOKE ALL ON TABLE public.wallet_topup_sessions FROM service_role;
REVOKE ALL ON TABLE public.momo_claim_attempts FROM service_role;
REVOKE ALL ON TABLE public.momo_reconciliation_runs FROM service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE public.momo_transactions TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.wallet_topup_sessions TO service_role;
GRANT SELECT ON TABLE public.momo_claim_attempts TO service_role;
GRANT SELECT, INSERT ON TABLE public.momo_reconciliation_runs TO service_role;

-- 6. Default settings. A re-run never overwrites an admin's change.
INSERT INTO public.admin_settings (key, value, description) VALUES
  ('momo_claim_enabled',               '{"value": false}'::jsonb,          'Send & Claim master switch. Off: no claims, no SMS intake credit.'),
  ('momo_payment_accounts',            '{"value": []}'::jsonb,             'MoMo numbers customers send to (list of {network, number}).'),
  ('momo_account_name',                '{"value": ""}'::jsonb,             'Account name shown to customers beside the MoMo number.'),
  ('momo_claim_fee_customer',          '{"value": 0}'::jsonb,              'Send & Claim fee for customers, percent of the amount sent (0-100), rounded up to the pesewa.'),
  ('momo_claim_fee_dealer',            '{"value": 0}'::jsonb,              'Send & Claim fee for dealers, percent of the amount sent (0-100), rounded up to the pesewa.'),
  ('momo_min_claimable',               '{"value": 10}'::jsonb,             'Smallest amount a claim may credit, GHS.'),
  ('momo_max_claimable',               '{"value": 2000}'::jsonb,           'Largest amount a claim may credit, GHS.'),
  ('momo_sms_sender_allowlist',        '{"value": ["MobileMoney"]}'::jsonb, 'SMS sender names accepted by intake; anything else is parked as rejected_sender.'),
  ('momo_txid_regression_threshold',   '{"value": 1000000}'::jsonb,        'A transaction id this far below the highest seen is flagged.'),
  ('momo_auto_claim_review_threshold', '{"value": 500}'::jsonb,            'Claims whose credited (net) amount is above this, GHS, go to review instead of auto-credit.'),
  ('momo_auto_claim_daily_cap',        '{"value": 3000}'::jsonb,           'Most a user may auto-claim in a day, GHS.')
ON CONFLICT (key) DO NOTHING;

-- 7. Money functions. Every Send & Claim wallet credit happens here.
--
-- Results (text): credited | under_review | already_credited | not_matched | no_session | rate_limited | daily_limit,
-- all in momo_claim_attempts_result_check. admin_unflag_momo_transaction returns 'unflagged'. Errors are fixed strings:
-- BAD_INPUT, BAD_STATE, NOT_FOUND, NO_WALLET, BAD_SETTING, CONFLICT (detail in DETAIL, never row data).
--
-- Lock order on every path: session -> momo row -> wallet. claim_momo_via_session first takes a per-user advisory lock
-- (only it takes one, so it cannot join a cycle); it serialises one user's claim-box calls so the rate limits hold.
-- Wallet credit is lock-first: lock the wallet row FOR UPDATE, THEN look for the ledger row MOMO-<txid>, then credit.
-- The momo row lock is the real double-credit guard (status 'claimed' is checked under it); the ledger check is the
-- backstop. credit_wallet_safely is NOT used: it checks the ledger before taking the lock.
--
-- Settings come from admin_settings (value->'value'), falling back to the default when missing or not a JSON number:
--   momo_claim_fee_customer 0, momo_claim_fee_dealer 0 (percent; public.users.role = 'dealer' pays the dealer one),
--   momo_auto_claim_review_threshold 500, momo_auto_claim_daily_cap 3000 (GHS).
-- Fee: claim box and webhook credit the SESSION's quoted fee and net_amount (what the customer was shown; it must add up
-- to the session amount, else BAD_STATE). Admin credit uses the linked session's quote when that session is the target's
-- and quoted this exact amount; otherwise it recomputes: fee = ceil(sent * round(pct, 2)) / 100 GHS (rounded UP to the
-- pesewa, as lib/momo-claim/money.ts), net = sent - fee. A fee percent outside 0..100 raises BAD_SETTING (fail closed).
-- The per-user checks run AFTER the wallet row is locked, so two claims for one user read the day's total in turn.
--
-- Per-user checks (claim box and webhook; never admin credit). Any hit: the momo row becomes 'flagged', the reasons
-- are appended to flag_reasons, session_id is linked, claimed_by stays NULL, the session stays 'pending', and the
-- result is 'under_review'. "Approve & credit" then passes the linked session's user to admin_credit_momo_transaction.
--   first_claim             the user has no momo_transactions row with status 'claimed' and claimed_by = user
--   above_review_threshold  net > threshold
--   daily_cap               today's (UTC day; Ghana is UTC+0) claimed net for the user + net > cap
--
-- A "failed" attempt is any result other than credited, under_review, already_credited.

-- 7a. Supports the per-user checks (first claim, today's total).
CREATE INDEX IF NOT EXISTS momo_transactions_claimed_by_idx
  ON public.momo_transactions (claimed_by, claimed_at) WHERE status = 'claimed';

-- 7b. A numeric setting, or the default when the key is missing or its value is not a JSON number. Internal.
CREATE OR REPLACE FUNCTION public.momo_setting_numeric(p_key text, p_default numeric)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT COALESCE(
    (SELECT CASE WHEN jsonb_typeof(s.value -> 'value') = 'number' THEN (s.value ->> 'value')::numeric END
       FROM public.admin_settings s
      WHERE s.key = p_key),
    p_default);
$fn$;

-- 7c. Fee and net for this user on this sent amount. Internal.
CREATE OR REPLACE FUNCTION public.momo_claim_fee(p_user uuid, p_amount numeric, OUT fee numeric, OUT net numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_role text;
  v_pct  numeric;
BEGIN
  IF p_amount IS NULL OR NOT (p_amount > 0) OR p_amount >= 1000000 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'amount must be positive';
  END IF;
  SELECT u.role INTO v_role FROM public.users u WHERE u.id = p_user;
  IF v_role = 'dealer' THEN
    v_pct := public.momo_setting_numeric('momo_claim_fee_dealer', 0);
  ELSE
    v_pct := public.momo_setting_numeric('momo_claim_fee_customer', 0);
  END IF;
  IF v_pct IS NULL OR v_pct < 0 OR v_pct > 100 THEN
    RAISE EXCEPTION 'BAD_SETTING' USING DETAIL = 'fee percent out of range';
  END IF;
  fee := round(ceil(p_amount * round(v_pct, 2)) / 100, 2);
  net := p_amount - fee;
END
$fn$;

-- 7d. Lock-first wallet credit with the ledger reference MOMO-<txid>. Returns 'credited' or 'already_credited'.
--     No wallet row raises NO_WALLET, which rolls the whole call back. Internal.
CREATE OR REPLACE FUNCTION public.momo_credit_wallet(p_txid text, p_user uuid, p_net numeric)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_ref CONSTANT text := 'MOMO-' || p_txid;
  v_bal numeric;
BEGIN
  IF p_txid IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'txid and user required';
  END IF;
  IF p_net IS NULL OR NOT (p_net > 0) OR p_net >= 1000000 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'net must be positive';
  END IF;

  -- Lock FIRST, then look at the ledger: a concurrent credit for this user waits here and then sees the row.
  SELECT w.balance INTO v_bal FROM public.wallets w WHERE w.user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_WALLET';
  END IF;

  -- This user's ledger, through the UNIQUE (user_id, reference_id, type) index. Cross-user double credit is blocked
  -- earlier, by the momo row lock and its status check.
  IF EXISTS (SELECT 1 FROM public.transactions t WHERE t.user_id = p_user AND t.reference_id = v_ref AND t.type = 'credit') THEN
    RETURN 'already_credited';
  END IF;

  UPDATE public.wallets w
     SET balance = w.balance + p_net,
         total_credited = COALESCE(w.total_credited, 0) + p_net,
         updated_at = now()
   WHERE w.user_id = p_user;

  INSERT INTO public.transactions (user_id, type, source, amount, balance_before, balance_after, description, reference_id, status, created_at)
  VALUES (p_user, 'credit', 'momo_claim', p_net, v_bal, v_bal + p_net, 'Wallet top-up: MoMo Send & Claim', v_ref, 'completed', now());

  RETURN 'credited';
END
$fn$;

-- 7e. The shared claim. Internal: only the two wrappers below call it, with the session already locked.
--     Returns credited | under_review | already_credited | not_matched.
CREATE OR REPLACE FUNCTION public.claim_momo_transaction(
  p_txid         text,
  p_user         uuid,
  p_session_id   uuid,
  p_check_amount boolean,
  p_mode         text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_sess    public.wallet_topup_sessions%ROWTYPE;
  v_tx      public.momo_transactions%ROWTYPE;
  v_fee     numeric;
  v_net     numeric;
  v_today   numeric;
  v_reasons text[] := ARRAY[]::text[];
  v_res     text;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('webhook', 'manual') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'mode must be webhook or manual';
  END IF;
  IF p_txid IS NULL OR p_user IS NULL OR p_session_id IS NULL OR p_check_amount IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'txid, user, session and amount check required';
  END IF;

  -- 1. The session (the caller holds its lock; taking it again is a no-op and keeps the order if a caller forgets).
  SELECT * INTO v_sess FROM public.wallet_topup_sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_sess.user_id IS DISTINCT FROM p_user OR v_sess.status <> 'pending' OR v_sess.expires_at <= now() THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'session is not open for this user';
  END IF;

  -- 2. The momo row, locked. Only a pending row may move on.
  SELECT * INTO v_tx FROM public.momo_transactions m WHERE m.transaction_id = p_txid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_matched';
  END IF;
  IF v_tx.status = 'claimed' AND v_tx.claimed_by = p_user THEN
    RETURN 'already_credited';
  END IF;
  IF v_tx.status <> 'pending' OR v_tx.received_at < v_sess.created_at THEN
    RETURN 'not_matched';
  END IF;

  -- 3. Amount, exact to the pesewa.
  IF v_tx.amount IS NULL OR (p_check_amount AND v_tx.amount <> v_sess.amount) THEN
    IF p_mode = 'webhook' AND v_tx.amount IS NOT NULL THEN
      UPDATE public.momo_transactions m
         SET status = 'flagged', flag_reasons = m.flag_reasons || ARRAY['amount_mismatch'], session_id = p_session_id, claimed_by = NULL
       WHERE m.id = v_tx.id;
      RETURN 'under_review';
    END IF;
    RETURN 'not_matched';
  END IF;

  -- 4. The session's quote (what the customer was shown), never recomputed here. It must add up.
  v_fee := v_sess.fee;
  v_net := v_sess.net_amount;
  IF v_fee IS NULL OR v_net IS NULL OR v_fee < 0 OR NOT (v_net > 0) OR v_fee + v_net <> v_sess.amount OR v_sess.amount <> v_tx.amount THEN
    RAISE EXCEPTION 'BAD_STATE' USING DETAIL = 'the session quote does not add up';
  END IF;

  -- 5. Lock the wallet BEFORE the per-user checks, so concurrent claims for one user (webhook and claim box) read the
  --    day's total one at a time. Lock order stays session -> row -> wallet. No wallet: the whole call rolls back.
  PERFORM 1 FROM public.wallets w WHERE w.user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_WALLET';
  END IF;

  -- 6. Per-user checks, under the wallet lock.
  IF NOT EXISTS (SELECT 1 FROM public.momo_transactions m WHERE m.claimed_by = p_user AND m.status = 'claimed') THEN
    v_reasons := v_reasons || ARRAY['first_claim'];
  END IF;
  IF v_net > public.momo_setting_numeric('momo_auto_claim_review_threshold', 500) THEN
    v_reasons := v_reasons || ARRAY['above_review_threshold'];
  END IF;
  SELECT COALESCE(sum(m.net_amount), 0) INTO v_today
    FROM public.momo_transactions m
   WHERE m.claimed_by = p_user AND m.status = 'claimed'
     AND m.claimed_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
  IF v_today + v_net > public.momo_setting_numeric('momo_auto_claim_daily_cap', 3000) THEN
    v_reasons := v_reasons || ARRAY['daily_cap'];
  END IF;
  IF cardinality(v_reasons) > 0 THEN
    UPDATE public.momo_transactions m
       SET status = 'flagged', flag_reasons = m.flag_reasons || v_reasons, session_id = p_session_id, claimed_by = NULL
     WHERE m.id = v_tx.id;
    RETURN 'under_review';
  END IF;

  -- 7. Credit (the wallet lock is already held; momo_credit_wallet takes it again, a no-op), then close the row and session.
  v_res := public.momo_credit_wallet(p_txid, p_user, v_net);
  IF v_res <> 'credited' THEN
    RETURN v_res;
  END IF;
  UPDATE public.momo_transactions m
     SET status = 'claimed', claimed_by = p_user, claimed_at = now(), fee = v_fee, net_amount = v_net, session_id = p_session_id
   WHERE m.id = v_tx.id;
  UPDATE public.wallet_topup_sessions s
     SET status = 'claimed', claimed_transaction_id = p_txid
   WHERE s.id = p_session_id;
  RETURN 'credited';
END
$fn$;

-- 7f. Webhook path: the SMS named a session code. Does not log attempts (no user acted).
--     no_session (and nothing changes) when the code is unknown, not pending, expired, or created after the payment.
CREATE OR REPLACE FUNCTION public.claim_via_wallet_topup_session(p_code text, p_txid text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_sess public.wallet_topup_sessions%ROWTYPE;
  v_recv timestamptz;
BEGIN
  IF p_code IS NULL OR p_txid IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'code and txid required';
  END IF;
  SELECT * INTO v_sess FROM public.wallet_topup_sessions s WHERE s.code = p_code FOR UPDATE;
  IF NOT FOUND OR v_sess.status <> 'pending' OR v_sess.expires_at <= now() THEN
    RETURN 'no_session';
  END IF;
  -- received_at never changes, so a plain read is enough; the row is locked inside the shared claim.
  SELECT m.received_at INTO v_recv FROM public.momo_transactions m WHERE m.transaction_id = p_txid;
  IF NOT FOUND THEN
    RETURN 'not_matched';
  END IF;
  IF v_sess.created_at > v_recv THEN
    RETURN 'no_session';
  END IF;
  RETURN public.claim_momo_transaction(p_txid, v_sess.user_id, v_sess.id, true, 'webhook');
END
$fn$;

-- 7g. Claim box. Logs EVERY call in momo_claim_attempts with the result it returns. Early rejections (rate_limited,
--     daily_limit, no_session, and a txid that is not 8-15 digits) are logged as 'NOSESSION'.
--     Order: per-user advisory lock -> 3 attempts / 30 s -> 20 failed / 24 h -> txid shape -> already credited to this
--     user (a read: a claimed row is final) -> lock the session (the given one, or the user's best open one: same amount
--     and created by the payment first, then newest) -> lock the momo row -> shared claim -> log -> 5 failed on this
--     txid since attempts_reset_at flags a still-pending row 'too_many_attempts'.
CREATE OR REPLACE FUNCTION public.claim_momo_via_session(p_user uuid, p_txid text, p_session_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_ok   CONSTANT text[] := ARRAY['credited', 'under_review', 'already_credited'];
  v_sess public.wallet_topup_sessions%ROWTYPE;
  v_tx   public.momo_transactions%ROWTYPE;
  v_amt  numeric;
  v_recv timestamptz;
  v_n    int;
  v_res  text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'user required';
  END IF;

  -- One claim-box call per user at a time, so the counts below cannot be raced past.
  PERFORM pg_advisory_xact_lock(hashtextextended('momo_claim_via_session:' || p_user::text, 0));

  SELECT count(*) INTO v_n FROM public.momo_claim_attempts a
   WHERE a.user_id = p_user AND a.created_at > now() - interval '30 seconds';
  IF v_n >= 3 THEN
    INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result) VALUES (p_user, 'NOSESSION', 'rate_limited');
    RETURN 'rate_limited';
  END IF;

  SELECT count(*) INTO v_n FROM public.momo_claim_attempts a
   WHERE a.user_id = p_user AND a.created_at > now() - interval '24 hours' AND NOT (a.result = ANY (v_ok));
  IF v_n >= 20 THEN
    INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result) VALUES (p_user, 'NOSESSION', 'daily_limit');
    RETURN 'daily_limit';
  END IF;

  IF p_txid IS NULL OR p_txid !~ '^[0-9]{8,15}$' THEN
    INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result) VALUES (p_user, 'NOSESSION', 'not_matched');
    RETURN 'not_matched';
  END IF;

  -- Already credited to this same user: say so (never for anyone else's row).
  IF EXISTS (SELECT 1 FROM public.momo_transactions m WHERE m.transaction_id = p_txid AND m.status = 'claimed' AND m.claimed_by = p_user) THEN
    INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result) VALUES (p_user, p_txid, 'already_credited');
    RETURN 'already_credited';
  END IF;

  -- The caller's own open session, locked.
  IF p_session_id IS NOT NULL THEN
    SELECT * INTO v_sess FROM public.wallet_topup_sessions s
     WHERE s.id = p_session_id AND s.user_id = p_user AND s.status = 'pending' AND s.expires_at > now()
       FOR UPDATE;
  ELSE
    SELECT m.amount, m.received_at INTO v_amt, v_recv FROM public.momo_transactions m WHERE m.transaction_id = p_txid;
    SELECT * INTO v_sess FROM public.wallet_topup_sessions s
     WHERE s.user_id = p_user AND s.status = 'pending' AND s.expires_at > now()
     ORDER BY (s.amount = v_amt AND s.created_at <= v_recv) IS TRUE DESC, s.created_at DESC, s.id
     LIMIT 1
       FOR UPDATE;
  END IF;
  IF v_sess.id IS NULL OR v_sess.status <> 'pending' OR v_sess.expires_at <= now() THEN
    INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result) VALUES (p_user, 'NOSESSION', 'no_session');
    RETURN 'no_session';
  END IF;

  -- The momo row, locked (after the session). Unknown, paid before the session, or not pending: one generic answer.
  SELECT * INTO v_tx FROM public.momo_transactions m WHERE m.transaction_id = p_txid FOR UPDATE;
  IF v_tx.id IS NULL OR v_tx.received_at < v_sess.created_at OR v_tx.status <> 'pending' THEN
    v_res := 'not_matched';
  ELSE
    v_res := public.claim_momo_transaction(p_txid, p_user, v_sess.id, true, 'manual');
  END IF;

  INSERT INTO public.momo_claim_attempts (user_id, transaction_id, result) VALUES (p_user, p_txid, v_res);

  -- 5 failed attempts on one real txid (any users) since its counter was reset: flag a still-pending row.
  IF NOT (v_res = ANY (v_ok)) AND v_tx.id IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.momo_transactions m WHERE m.id = v_tx.id;
    IF v_tx.status = 'pending' THEN
      SELECT count(*) INTO v_n FROM public.momo_claim_attempts a
       WHERE a.transaction_id = p_txid AND a.created_at >= v_tx.attempts_reset_at AND NOT (a.result = ANY (v_ok));
      IF v_n >= 5 THEN
        UPDATE public.momo_transactions m
           SET status = 'flagged', flag_reasons = m.flag_reasons || ARRAY['too_many_attempts']
         WHERE m.id = v_tx.id;
      END IF;
    END IF;
  END IF;

  RETURN v_res;
END
$fn$;

-- 7h. Admin "Approve & credit" / "Assign to user". No per-user checks. p_amount is the SENT amount: required when the row
--     has no parsed amount (unparsed), and then stored; otherwise NULL or equal to the row's amount. Reason 1-200 chars.
--     Locks the linked session (if any), then the row, then the wallet. Closes the linked session when it is the target
--     user's and still pending. Returns 'credited' or 'already_credited' (row already claimed, or ledger row present).
CREATE OR REPLACE FUNCTION public.admin_credit_momo_transaction(
  p_txid        text,
  p_target_user uuid,
  p_admin       uuid,
  p_reason      text,
  p_amount      numeric DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_sid  uuid;
  v_sess public.wallet_topup_sessions%ROWTYPE;
  v_tx   public.momo_transactions%ROWTYPE;
  v_amt  numeric;
  v_fee  numeric;
  v_net  numeric;
  v_res  text;
  v_quote boolean;
BEGIN
  IF p_txid IS NULL OR p_target_user IS NULL OR p_admin IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'txid, target user and admin required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 1 OR length(btrim(p_reason)) > 200 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'reason must be 1 to 200 characters';
  END IF;

  -- Session first: read the link, lock the session, then lock the row and make sure the link did not move.
  SELECT m.session_id INTO v_sid FROM public.momo_transactions m WHERE m.transaction_id = p_txid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;
  IF v_sid IS NOT NULL THEN
    SELECT * INTO v_sess FROM public.wallet_topup_sessions s WHERE s.id = v_sid FOR UPDATE;
  END IF;
  SELECT * INTO v_tx FROM public.momo_transactions m WHERE m.transaction_id = p_txid FOR UPDATE;
  IF v_tx.session_id IS DISTINCT FROM v_sid THEN
    RAISE EXCEPTION 'CONFLICT' USING DETAIL = 'the row changed; try again';
  END IF;

  IF v_tx.status = 'claimed' THEN
    RETURN 'already_credited';
  END IF;
  IF v_tx.status NOT IN ('pending', 'flagged', 'unparsed') THEN
    RAISE EXCEPTION 'BAD_STATE' USING DETAIL = 'only pending, flagged or unparsed rows can be credited';
  END IF;

  IF v_tx.amount IS NULL THEN
    IF p_amount IS NULL OR NOT (p_amount > 0) OR p_amount >= 1000000 OR p_amount <> round(p_amount, 2) THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'this row has no amount: give the sent amount (positive, 2 decimals)';
    END IF;
    v_amt := p_amount;
  ELSE
    IF p_amount IS NOT NULL AND p_amount <> v_tx.amount THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'amount differs from the SMS amount';
    END IF;
    v_amt := v_tx.amount;
  END IF;

  -- The linked session's quote when it is the target's and quoted this very amount (an amount_mismatch session quoted
  -- another amount, so paying its net could pay more than was sent). Otherwise recompute from the target's role.
  v_quote := v_sess.id IS NOT NULL AND v_sess.user_id = p_target_user AND v_sess.amount = v_amt;
  IF v_quote THEN
    v_fee := v_sess.fee;
    v_net := v_sess.net_amount;
    IF v_fee IS NULL OR v_net IS NULL OR v_fee < 0 OR NOT (v_net > 0) OR v_fee + v_net <> v_amt THEN
      RAISE EXCEPTION 'BAD_STATE' USING DETAIL = 'the session quote does not add up';
    END IF;
  ELSE
    SELECT f.fee, f.net INTO v_fee, v_net FROM public.momo_claim_fee(p_target_user, v_amt) f;
  END IF;

  v_res := public.momo_credit_wallet(p_txid, p_target_user, v_net);
  IF v_res <> 'credited' THEN
    RETURN v_res;
  END IF;

  UPDATE public.momo_transactions m
     SET status = 'claimed', amount = v_amt, claimed_by = p_target_user, claimed_at = now(), fee = v_fee, net_amount = v_net,
         credited_by_admin = p_admin, admin_reason = btrim(p_reason)
   WHERE m.id = v_tx.id;
  IF v_quote AND v_sess.status = 'pending' THEN
    UPDATE public.wallet_topup_sessions s
       SET status = 'claimed', claimed_transaction_id = p_txid
     WHERE s.id = v_sess.id;
  END IF;
  RETURN 'credited';
END
$fn$;

-- 7i. Admin unflag: flagged -> pending (no credit). Records who, when and why, and restarts the per-txid attempt count.
CREATE OR REPLACE FUNCTION public.admin_unflag_momo_transaction(p_txid text, p_admin uuid, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_tx public.momo_transactions%ROWTYPE;
BEGIN
  IF p_txid IS NULL OR p_admin IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'txid and admin required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 1 OR length(btrim(p_reason)) > 200 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'reason must be 1 to 200 characters';
  END IF;
  SELECT * INTO v_tx FROM public.momo_transactions m WHERE m.transaction_id = p_txid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;
  IF v_tx.status <> 'flagged' THEN
    RAISE EXCEPTION 'BAD_STATE' USING DETAIL = 'only a flagged row can be unflagged';
  END IF;
  UPDATE public.momo_transactions m
     SET status = 'pending', unflagged_by = p_admin, unflagged_at = now(), unflag_reason = btrim(p_reason), attempts_reset_at = now()
   WHERE m.id = v_tx.id;
  RETURN 'unflagged';
END
$fn$;

-- 7j. EXECUTE. Internal functions: nobody (only the definer wrappers, which run as the owner). Entry points: service_role.
REVOKE ALL ON FUNCTION public.momo_setting_numeric(text, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.momo_claim_fee(uuid, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.momo_credit_wallet(text, uuid, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_momo_transaction(text, uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.claim_via_wallet_topup_session(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_momo_via_session(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_credit_momo_transaction(text, uuid, uuid, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_unflag_momo_transaction(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_via_wallet_topup_session(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_momo_via_session(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_credit_momo_transaction(text, uuid, uuid, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_unflag_momo_transaction(text, uuid, text) TO service_role;

-- 7k. Admin fraud list: users with many claim attempts in the last 24 hours. Aggregated here so the API never depends on
-- PostgREST's row cap. service_role only.
CREATE OR REPLACE FUNCTION public.momo_suspicious_claimers(p_min_attempts int DEFAULT 5, p_limit int DEFAULT 100)
RETURNS TABLE(user_id uuid, attempts bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT a.user_id, count(*) AS attempts
    FROM public.momo_claim_attempts a
   WHERE a.created_at >= now() - interval '24 hours'
   GROUP BY a.user_id
  HAVING count(*) >= p_min_attempts
   ORDER BY 2 DESC, 1
   LIMIT least(greatest(p_limit, 1), 500)
$fn$;
REVOKE ALL ON FUNCTION public.momo_suspicious_claimers(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.momo_suspicious_claimers(int, int) TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT c.relname, c.relrowsecurity FROM pg_class c
--    WHERE c.oid IN ('public.momo_transactions'::regclass, 'public.wallet_topup_sessions'::regclass,
--                    'public.momo_claim_attempts'::regclass, 'public.momo_reconciliation_runs'::regclass);   -- 4 rows, all true
--   SELECT count(*) FROM pg_policies WHERE tablename IN ('momo_transactions','wallet_topup_sessions','momo_claim_attempts','momo_reconciliation_runs');   -- 0
--   SELECT t, has_table_privilege('anon', 'public.' || t, 'SELECT'), has_table_privilege('authenticated', 'public.' || t, 'SELECT')
--     FROM unnest(ARRAY['momo_transactions','wallet_topup_sessions','momo_claim_attempts','momo_reconciliation_runs']) t;   -- all false, false
--   SELECT key, value FROM admin_settings WHERE key LIKE 'momo\_%' ORDER BY key;   -- 11 rows; momo_claim_enabled = {"value": false}
--   SELECT count(*) FROM momo_transactions;                                         -- 0 until the SMS intake is live
--   SELECT f, has_function_privilege('anon', f, 'EXECUTE'), has_function_privilege('authenticated', f, 'EXECUTE'),
--          has_function_privilege('service_role', f, 'EXECUTE')
--     FROM unnest(ARRAY['public.claim_via_wallet_topup_session(text,text)', 'public.claim_momo_via_session(uuid,text,uuid)',
--                       'public.admin_credit_momo_transaction(text,uuid,uuid,text,numeric)', 'public.admin_unflag_momo_transaction(text,uuid,text)',
--                       'public.claim_momo_transaction(text,uuid,uuid,boolean,text)', 'public.momo_credit_wallet(text,uuid,numeric)',
--                       'public.momo_claim_fee(uuid,numeric)', 'public.momo_setting_numeric(text,numeric)']) f;
--     -- first four: false, false, true; last four: false, false, false
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'momo_claim_attempts_result_check';   -- the eight results
