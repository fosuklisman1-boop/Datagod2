-- 0183_shop_customer_prefs.sql
--
-- USSD shop memory, Task 1: ONE remembered shop per customer phone, shared by every shop channel (USSD Hubtel + Uzo,
-- SMS Text-to-Buy, WhatsApp shop bot). ADDITIVE; service-role only. NOT applied by the implementing agent. One transaction.
-- Idempotent (re-runnable). Nothing reads this table until later tasks of the plan.
--
--   shop_customer_prefs(phone PK local 0XXXXXXXXX, shop_code_id FK ussd_shop_codes ON DELETE CASCADE, last_channel, last_used_at)
--
-- Backfill: the newest row per phone across ttb_shop_prefs (sender, already local; channel 'sms') and wa_shop_customer_prefs
-- (phone, usually 233XXXXXXXXX, rewritten to local; channel 'whatsapp'). Phones that are not 0 + 9 digits are skipped.
-- ON CONFLICT DO NOTHING, so a re-run never overwrites a newer live row.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.shop_customer_prefs');                                                       -- NULL
--   SELECT to_regclass('public.ussd_shop_codes'), to_regclass('public.ttb_shop_prefs'), to_regclass('public.wa_shop_customer_prefs');  -- all NOT NULL
--
-- Dry run: migrations/0183_shop_customer_prefs.selftest.sql (build the run string by code, as lib/shop-commerce/migration-0183.test.ts does).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.shop_customer_prefs (
  phone        text PRIMARY KEY CHECK (phone ~ '^0[0-9]{9}$'),
  shop_code_id uuid NOT NULL REFERENCES public.ussd_shop_codes(id) ON DELETE CASCADE,
  last_channel text NOT NULL CHECK (last_channel IN ('ussd_hubtel', 'ussd_uzo', 'sms', 'whatsapp')),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

-- Service-role only: RLS on, no policies, nothing for anon / authenticated.
ALTER TABLE public.shop_customer_prefs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_customer_prefs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.shop_customer_prefs TO service_role;

-- Backfill, newest wins per phone.
INSERT INTO public.shop_customer_prefs (phone, shop_code_id, last_channel, last_used_at)
SELECT DISTINCT ON (u.phone) u.phone, u.shop_code_id, u.channel, u.last_used_at
  FROM (
    SELECT sender AS phone, shop_code_id, 'sms'::text AS channel, last_used_at
      FROM public.ttb_shop_prefs
    UNION ALL
    SELECT regexp_replace(phone, '^\+?233', '0') AS phone, shop_code_id, 'whatsapp'::text AS channel, last_used_at
      FROM public.wa_shop_customer_prefs
  ) u
 WHERE u.phone ~ '^0[0-9]{9}$'
 ORDER BY u.phone, u.last_used_at DESC
ON CONFLICT (phone) DO NOTHING;

COMMIT;
