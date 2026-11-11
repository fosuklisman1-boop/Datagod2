-- 0160_momo_send_and_claim.sql
--
-- Send & Claim: a customer sends MoMo to Datagod's number, then claims the credit with the MoMo transaction id (or a
-- session code). Spec and plan: docs/ (momo-claim). This file holds the TABLES and default SETTINGS. The money functions
-- (SECURITY DEFINER, service_role only) are added to this same file by the next task, after the tables and before COMMIT.
-- ADDITIVE; service-role only. NOT applied by the implementing agent. Nothing reads these tables until a later task.
-- One transaction. Idempotent (re-runnable).
--
--   wallet_topup_sessions     a code the customer gets before paying: amount, fee, net credit, expiry. Created first,
--                             because momo_transactions.session_id references it.
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
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.momo_transactions'), to_regclass('public.wallet_topup_sessions'),
--          to_regclass('public.momo_claim_attempts'), to_regclass('public.momo_reconciliation_runs');   -- all NULL
--   SELECT count(*) FROM admin_settings WHERE key LIKE 'momo\_%';                                        -- 0
--   SELECT data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'admin_settings' AND column_name = 'value';          -- jsonb
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
  user_id               uuid NOT NULL REFERENCES auth.users(id),
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
  session_id          uuid REFERENCES public.wallet_topup_sessions(id),
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
  ('momo_claim_fee_customer',          '{"value": 0}'::jsonb,              'Send & Claim fee for customers, GHS.'),
  ('momo_claim_fee_dealer',            '{"value": 0}'::jsonb,              'Send & Claim fee for dealers, GHS.'),
  ('momo_min_claimable',               '{"value": 10}'::jsonb,             'Smallest amount a claim may credit, GHS.'),
  ('momo_max_claimable',               '{"value": 2000}'::jsonb,           'Largest amount a claim may credit, GHS.'),
  ('momo_sms_sender_allowlist',        '{"value": ["MobileMoney"]}'::jsonb, 'SMS sender names accepted by intake; anything else is parked as rejected_sender.'),
  ('momo_txid_regression_threshold',   '{"value": 1000000}'::jsonb,        'A transaction id this far below the highest seen is flagged.'),
  ('momo_auto_claim_review_threshold', '{"value": 500}'::jsonb,            'Claims at or above this amount, GHS, go to review instead of auto-credit.'),
  ('momo_auto_claim_daily_cap',        '{"value": 3000}'::jsonb,           'Most a user may auto-claim in a day, GHS.')
ON CONFLICT (key) DO NOTHING;

-- 7. Money functions: added by the next task, here, before COMMIT.

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
