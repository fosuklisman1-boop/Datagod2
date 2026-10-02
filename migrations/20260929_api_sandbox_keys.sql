-- 20260929_api_sandbox_keys.sql
--
-- Adds a real sandbox/live split to the Developer API, replacing the old
-- "up to 5 named live keys" model with exactly one test key + one live key
-- per account (dg_test_.../dg_live_...). Also adds a fake, self-contained
-- test-balance ledger and a shared sandbox_orders table that every
-- simulated v1 action (data orders, airtime, AFA, results-checker) writes
-- to -- this NEVER touches real orders/airtime_orders/afa_orders/
-- results_checker_orders, real wallets, or real provider dispatch.
--
-- Live data check before writing this (2026-09-29, Supabase Management API):
-- user_api_keys had 19 rows / 17 active / 17 distinct users, only 2 users
-- had more than one active key, and only 6 keys had EVER been used
-- (last_used_at not null) out of 19 total. Real-world breakage risk from
-- collapsing to one active key per user is low, but the dedup step below
-- still prefers whichever key has actual usage evidence over an unused one.

-- 1. Tag every existing key as 'live' (dg_live_ was the only prefix that
--    has ever existed) and prepare for exactly one active key per
--    (user_id, environment).
ALTER TABLE public.user_api_keys
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'live'
    CHECK (environment IN ('test', 'live'));

-- 2. Dedup: for the 2 users with 2 active keys, keep whichever has been
--    used most recently: if neither has been used, keep the older one.
--    Deactivate the rest before the uniqueness constraint below.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, environment
           ORDER BY (last_used_at IS NOT NULL) DESC, last_used_at DESC NULLS LAST, created_at ASC
         ) AS rn
  FROM public.user_api_keys
  WHERE is_active = true
)
UPDATE public.user_api_keys
SET is_active = false, updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3. At most one active key per user per environment.
CREATE UNIQUE INDEX IF NOT EXISTS user_api_keys_one_active_per_env
  ON public.user_api_keys (user_id, environment)
  WHERE is_active = true;

-- 4. Sandbox wallet: an independent fake balance a test key spends against.
--    Starts every user at GHS 100 in test credit. Never linked to the real
--    `wallets` table in any way.
CREATE TABLE IF NOT EXISTS public.sandbox_wallets (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance NUMERIC NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Sandbox orders: one shared table for every simulated action a test
--    key places. `resolves_at` lets status be derived at read time
--    (pending until resolves_at, completed after) with no cron needed.
CREATE TABLE IF NOT EXISTS public.sandbox_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  api_key_id UUID NOT NULL REFERENCES public.user_api_keys(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('data_order', 'airtime', 'afa', 'results_checker')),
  reference TEXT NOT NULL,
  request JSONB NOT NULL,
  response JSONB NOT NULL,
  price NUMERIC NOT NULL,
  resolves_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, reference)
);

CREATE INDEX IF NOT EXISTS sandbox_orders_user_id_idx ON public.sandbox_orders (user_id);

-- 6. Lock both new tables to service_role only -- same posture as the real
--    financial tables in 0076/0077. Nothing in the app reads/writes these
--    directly from the browser; everything goes through the service-role
--    v1 API routes. RLS enabled with no policies blocks authenticated/anon
--    entirely (service_role bypasses RLS as always); the 0077 fix already
--    means new tables don't get automatic authenticated write grants, and
--    this explicitly locks out the automatic SELECT grant too.
ALTER TABLE public.sandbox_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sandbox_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sandbox_wallets FROM authenticated, anon;
REVOKE ALL ON public.sandbox_orders FROM authenticated, anon;
