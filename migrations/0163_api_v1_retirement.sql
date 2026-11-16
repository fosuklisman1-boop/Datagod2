-- 0163_api_v1_retirement.sql
--
-- Retiring the public developer API v1: three columns on the single-row config table api_v2_config (0128).
--   v1_sunset_at        timestamptz, NULL = no sunset set. Once set, v1 responses carry Deprecation/Sunset headers; from
--                       exactly this instant v1 answers 410.
--   v1_exempt_user_ids  uuid[], users who keep v1 after the sunset and get headers only (no body notice). Default empty.
--   v1_notice_sent_at   timestamptz, when the one-off customer notice went out (NULL = not yet).
-- RLS (enabled, no policies) and grants (anon/authenticated revoked) from 0128 are NOT touched: service_role only.
-- One transaction. Idempotent (add column if not exists). NOT applied by the implementing agent.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT count(*) FROM public.api_v2_config;                                              -- 1
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'api_v2_config' AND column_name LIKE 'v1\_%';   -- 0
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.api_v2_config'::regclass;       -- true
--
-- Self-test (self-rolling-back dry run): migrations/0163_api_v1_retirement.selftest.sql. The run string must be built by
-- CODE which asserts it contains no COMMIT and no bare END; statement; lib/api-v1/migration-0163.test.ts builds and checks it.
--
-- ROLLBACK (if ever needed): ALTER TABLE public.api_v2_config DROP COLUMN v1_sunset_at, DROP COLUMN v1_exempt_user_ids,
-- DROP COLUMN v1_notice_sent_at;  (only after the app code that reads them is reverted).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.api_v2_config
  ADD COLUMN IF NOT EXISTS v1_sunset_at       timestamptz,
  ADD COLUMN IF NOT EXISTS v1_exempt_user_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS v1_notice_sent_at  timestamptz;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Verify after apply (read-only):
--   SELECT v1_sunset_at, v1_exempt_user_ids, v1_notice_sent_at FROM public.api_v2_config;   -- NULL | {} | NULL
--   SELECT has_table_privilege('anon', 'public.api_v2_config', 'SELECT');                    -- false
