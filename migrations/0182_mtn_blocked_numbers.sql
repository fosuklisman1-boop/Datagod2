-- 0182_mtn_blocked_numbers.sql
--
-- Blocked MTN numbers tracking: the number registry and the per-attempt log. ADDITIVE; service-role only. NOT applied by the
-- implementing agent. One transaction. Idempotent (re-runnable). No dependency on earlier migrations. Ships dark: nothing
-- reads or writes these tables until later tasks of the plan.
--
--   mtn_blocked_numbers    one row per canonical phone (0XXXXXXXXX) that every checkout provider rejected: status, recheck
--                          schedule, customer notification state, supplier submission and admin handling.
--   mtn_blocked_attempts   one row per deduped attempt to buy for a blocked number (surface, shop, user, purchaser phone).
--                          Carries purchaser phones, so the cron purges rows older than 90 days. CASCADE with the number.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.mtn_blocked_numbers'), to_regclass('public.mtn_blocked_attempts');       -- NULL, NULL
--
-- Self-test (self-rolling-back dry run): migrations/0182_mtn_blocked_numbers.selftest.sql
-- The run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement
-- (the 0130 incident lesson); lib/blocked-numbers/migration-0182.test.ts builds and checks it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. The number registry.
CREATE TABLE IF NOT EXISTS public.mtn_blocked_numbers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone                 text NOT NULL UNIQUE,                                         -- canonical 0XXXXXXXXX
  status                text NOT NULL DEFAULT 'blocked' CHECK (status IN ('blocked', 'allowed', 'expired', 'handled')),
  first_blocked_at      timestamptz NOT NULL DEFAULT now(),
  last_blocked_at       timestamptz NOT NULL DEFAULT now(),
  attempts              int NOT NULL DEFAULT 1,                                       -- deduped attempts
  providers_rejected    text[] NOT NULL DEFAULT '{}',                                 -- ordered provider list at the last block
  recheck_count         int NOT NULL DEFAULT 0,
  last_rechecked_at     timestamptz,
  next_recheck_at       timestamptz,
  expires_at            timestamptz,                                                  -- first_blocked_at + retention_days
  allowed_at            timestamptz,
  allowed_by            text,                                                         -- provider that approved on the flip
  customer_notified_at  timestamptz,
  customer_notify_phone text,
  notify_attempts       int NOT NULL DEFAULT 0,
  ready_sms_count       int NOT NULL DEFAULT 0,
  ready_sms_window_start timestamptz,
  submitted_to_supplier text,
  submitted_at          timestamptz,
  handled_at            timestamptz,
  handled_by            uuid,
  notes                 text,
  last_surface          text,
  last_shop_id          uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mtn_blocked_numbers_recheck_idx
  ON public.mtn_blocked_numbers (status, next_recheck_at) WHERE status = 'blocked';
CREATE INDEX IF NOT EXISTS mtn_blocked_numbers_notify_idx
  ON public.mtn_blocked_numbers (status, customer_notified_at) WHERE status = 'allowed';
CREATE INDEX IF NOT EXISTS mtn_blocked_numbers_shop_idx
  ON public.mtn_blocked_numbers (last_shop_id, last_blocked_at DESC);
CREATE INDEX IF NOT EXISTS mtn_blocked_numbers_notify_phone_idx
  ON public.mtn_blocked_numbers (customer_notify_phone, customer_notified_at);

-- 2. The attempt log.
CREATE TABLE IF NOT EXISTS public.mtn_blocked_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocked_number_id uuid NOT NULL REFERENCES public.mtn_blocked_numbers (id) ON DELETE CASCADE,
  phone             text NOT NULL,
  surface           text NOT NULL CHECK (surface IN ('storefront', 'storefront_preview', 'dashboard', 'dashboard_preview',
                      'dashboard_bulk', 'dashboard_bulk_preview', 'api_v1', 'api_v2', 'ussd_hubtel', 'ussd_hubtel_shop',
                      'ussd_uzo', 'ussd_uzo_shop', 'whatsapp_shop', 'whatsapp_ai', 'text_to_buy', 'text_to_buy_airtime', 'unknown')),
  shop_id           uuid,
  user_id           uuid,
  purchaser_phone   text,
  product           text,
  amount            numeric,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mtn_blocked_attempts_shop_idx ON public.mtn_blocked_attempts (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mtn_blocked_attempts_user_idx ON public.mtn_blocked_attempts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mtn_blocked_attempts_phone_idx ON public.mtn_blocked_attempts (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS mtn_blocked_attempts_created_idx ON public.mtn_blocked_attempts (created_at);
CREATE INDEX IF NOT EXISTS mtn_blocked_attempts_number_idx ON public.mtn_blocked_attempts (blocked_number_id);

-- 3. Lock both down. No policies on purpose; 0060 grants authenticated CRUD by default, the REVOKE keeps it out.
ALTER TABLE public.mtn_blocked_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtn_blocked_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mtn_blocked_numbers FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.mtn_blocked_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mtn_blocked_numbers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mtn_blocked_attempts TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.oid IN ('public.mtn_blocked_numbers'::regclass, 'public.mtn_blocked_attempts'::regclass);  -- 2 rows, true
--   SELECT count(*) FROM pg_policies WHERE tablename IN ('mtn_blocked_numbers', 'mtn_blocked_attempts');                                                 -- 0
--   SELECT has_table_privilege('anon', 'public.mtn_blocked_numbers', 'SELECT'), has_table_privilege('authenticated', 'public.mtn_blocked_attempts', 'SELECT'),
--          has_table_privilege('service_role', 'public.mtn_blocked_numbers', 'UPDATE');                                                                  -- false, false, true
