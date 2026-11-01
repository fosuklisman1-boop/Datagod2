-- Short-lived cache of definite customer-facing MTN verification verdicts
-- (lib/mtn-providers/verdict-cache.ts). Used when Upstash Redis isn't
-- configured, so a check that outlives one USSD screen (it keeps running after
-- the reply) still answers the "Pay now" gate. Rows expire after 10 minutes and
-- are purged opportunistically by the app. Server-only (service role).
--
-- cache_key = mtnverify:v1:<ordered provider list>:<last 9 digits of the number>
CREATE TABLE IF NOT EXISTS public.mtn_verdict_cache (
  cache_key  TEXT PRIMARY KEY,
  verdict    BOOLEAN NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mtn_verdict_cache_expires_at ON public.mtn_verdict_cache (expires_at);

ALTER TABLE public.mtn_verdict_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mtn_verdict_cache FROM PUBLIC, anon, authenticated;
