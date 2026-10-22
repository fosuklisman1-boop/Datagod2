-- 0128_api_v2_foundation.sql
--
-- Foundation schema for Developer API v2 (/api/v2, built beside the existing
-- /api/v1 which is NOT touched here).
--
--   api_v2_keys   one row per key. Typed (standard / commission / sms),
--                 environment-tagged (test / live), and admin-approved
--                 (pending -> active -> revoked). Only a hash of the key is
--                 stored; key_prefix is the non-secret display prefix.
--   api_v2_logs   request log for v2 calls (no request/response bodies, no PII
--                 beyond ip_address).
--   api_v2_config single-row feature switch (enabled + allowed_roles). A
--                 dedicated table on purpose: app_settings already suffered a
--                 singleton-vs-key-value collision.
--
-- All three tables are service_role only: RLS enabled with no policies, and
-- authenticated/anon grants revoked, same posture as
-- 20260929_api_sandbox_keys.sql. Everything goes through service-role routes.

-- 1. Keys.
CREATE TABLE IF NOT EXISTS public.api_v2_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_type TEXT NOT NULL CHECK (key_type IN ('standard', 'commission', 'sms')),
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  -- NULL = defaults. Shape: {purchase?, bulk?, balance?, status?}
  rate_limits JSONB,
  last_used_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by UUID,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one pending-or-active key per user per type per environment.
CREATE UNIQUE INDEX IF NOT EXISTS api_v2_keys_one_live_per_type
  ON public.api_v2_keys (user_id, key_type, environment)
  WHERE status IN ('pending', 'active');

CREATE INDEX IF NOT EXISTS api_v2_keys_status_idx ON public.api_v2_keys (status);
CREATE INDEX IF NOT EXISTS api_v2_keys_user_id_idx ON public.api_v2_keys (user_id);

-- 2. Request log.
CREATE TABLE IF NOT EXISTS public.api_v2_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id UUID REFERENCES public.api_v2_keys(id) ON DELETE SET NULL,
  user_id UUID,
  method TEXT,
  endpoint TEXT,
  status_code INT,
  error_code INT,
  ip_address TEXT,
  duration_ms INT,
  environment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_v2_logs_created_at_idx ON public.api_v2_logs (created_at);
CREATE INDEX IF NOT EXISTS api_v2_logs_key_id_created_at_idx ON public.api_v2_logs (key_id, created_at);

-- 3. Config: exactly one row, enforced by the boolean primary key + check.
--    Ships disabled; restricted to admins until widened.
CREATE TABLE IF NOT EXISTS public.api_v2_config (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  enabled BOOLEAN NOT NULL DEFAULT false,
  allowed_roles TEXT[] NOT NULL DEFAULT '{admin}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);

INSERT INTO public.api_v2_config (id) VALUES (true) ON CONFLICT DO NOTHING;

-- 4. Lock to service_role only.
ALTER TABLE public.api_v2_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_v2_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_v2_keys FROM authenticated, anon;
REVOKE ALL ON public.api_v2_logs FROM authenticated, anon;
REVOKE ALL ON public.api_v2_config FROM authenticated, anon;
