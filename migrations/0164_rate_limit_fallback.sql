-- 0164_rate_limit_fallback.sql
--
-- Opt-in Postgres fallback for the Upstash rate limiter (lib/rate-limiter.ts). When Redis is over its cap or down, the
-- developer API v2 purchase routes (and only callers passing { pgFallback: true }) count requests here instead of
-- failing every purchase with 503.
--   1. table public.rate_limit_fallback(bucket, window_start, hits), PK (bucket, window_start). RLS on, NO policies, and
--      every privilege revoked from PUBLIC/anon/authenticated: only the definer RPC (and service_role) touch it.
--   2. RPC public.rate_limit_fallback_hit(p_bucket text, p_max int, p_window_seconds int)
--      returns table(allowed boolean, remaining int, reset_at timestamptz). SECURITY DEFINER, search_path = public.
--      Fixed window: window_start = now() truncated to the window size; ONE statement
--      INSERT ... ON CONFLICT DO UPDATE SET hits = hits + 1 RETURNING hits (atomic under concurrency). On about 1% of
--      calls it deletes rows older than 1 hour. p_max and p_window_seconds must be > 0 (else BAD_INPUT).
--   3. EXECUTE: service_role only.
-- One transaction. Idempotent (re-runnable). NOT applied by the implementing agent.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.rate_limit_fallback');                                              -- NULL (first apply)
--   SELECT count(*) FROM pg_proc WHERE proname = 'rate_limit_fallback_hit';                        -- 0 (first apply)
--
-- Self-test (self-rolling-back dry run): migrations/0164_rate_limit_fallback.selftest.sql
-- The run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement (the 0130
-- incident lesson); lib/rate-limit-fallback-migration.test.ts builds and checks it.
--
-- ROLLBACK: DROP FUNCTION public.rate_limit_fallback_hit(text, int, int); DROP TABLE public.rate_limit_fallback;
-- (callers get null from pgFallbackLimit and behave as before: degraded).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. The counters.
CREATE TABLE IF NOT EXISTS public.rate_limit_fallback (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         int         NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
ALTER TABLE public.rate_limit_fallback ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: nobody but the table owner / service_role (BYPASSRLS) can read or write it.
REVOKE ALL ON public.rate_limit_fallback FROM PUBLIC, anon, authenticated;

-- 2. The hit counter.
CREATE OR REPLACE FUNCTION public.rate_limit_fallback_hit(
  p_bucket         text,
  p_max            int,
  p_window_seconds int
)
RETURNS TABLE (allowed boolean, remaining int, reset_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_start timestamptz;
  v_hits  int;
BEGIN
  IF p_bucket IS NULL OR length(p_bucket) = 0 OR p_max IS NULL OR p_max <= 0
     OR p_window_seconds IS NULL OR p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'bucket, max > 0 and window_seconds > 0 required';
  END IF;

  v_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);

  -- One statement: atomic under concurrency.
  INSERT INTO public.rate_limit_fallback AS r (bucket, window_start, hits)
  VALUES (p_bucket, v_start, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING r.hits INTO v_hits;

  -- Opportunistic cleanup, about 1% of calls.
  IF random() < 0.01 THEN
    DELETE FROM public.rate_limit_fallback d WHERE d.window_start < now() - interval '1 hour';
  END IF;

  allowed   := v_hits <= p_max;
  remaining := GREATEST(p_max - v_hits, 0);
  reset_at  := v_start + make_interval(secs => p_window_seconds);
  RETURN NEXT;
END
$fn$;

-- 3. EXECUTE: service_role only.
REVOKE EXECUTE ON FUNCTION public.rate_limit_fallback_hit(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_fallback_hit(text, int, int) TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rate_limit_fallback'::regclass;   -- true
--   SELECT r, has_function_privilege(r, 'public.rate_limit_fallback_hit(text,int,int)', 'EXECUTE')
--     FROM unnest(ARRAY['anon','authenticated','service_role']) r;   -- false, false, true
