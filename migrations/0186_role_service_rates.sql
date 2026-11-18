-- 0186_role_service_rates.sql
--
-- Custom roles, Phase 2d Task 1: per-role service rates (airtime fee and cashback share percentages). ADDITIVE; service-role
-- only. NOT applied by the implementing agent. One transaction. Idempotent (re-runnable). Nothing reads the table yet.
-- No seed, no triggers, no functions.
--
--   role_service_rates(role_id -> roles ON DELETE CASCADE, service_key, value numeric(6,2) in [0,100], updated_at)
--   PRIMARY KEY (role_id, service_key); service_key matches ^[a-z_]+:[a-z0-9_]+$
--
-- Service keys used in this phase:
--   airtime_fee:mtn | airtime_fee:telecel | airtime_fee:at
--   cashback_share:airtime | cashback_share:bundles | cashback_share:bills
--   cashback_share:<serviceKey>   per-service override (serviceKey normalised to [a-z0-9_])
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.role_service_rates');  -- NULL
--   SELECT to_regclass('public.roles');  -- NOT NULL (0184 applied)
--   -- Do NOT insert any non-system roles row until Phase 2 is complete (lib/roles/flags.ts).
--
-- Dry run: migrations/0186_role_service_rates.selftest.sql (build the run string by code, as lib/roles/migration-0186.test.ts does).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.role_service_rates (
  role_id     uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  service_key text NOT NULL CHECK (service_key ~ '^[a-z_]+:[a-z0-9_]+$'),
  value       numeric(6,2) NOT NULL CHECK (value >= 0 AND value <= 100),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, service_key)
);

ALTER TABLE public.role_service_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.role_service_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_service_rates TO service_role;

COMMIT;
