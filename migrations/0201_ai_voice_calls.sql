-- 0201_ai_voice_calls.sql
--
-- Nuance Live voice/video calls with the "Clings" AI assistant: one row per call, so the per-user, per-device and
-- per-visitor daily caps can be counted. Written and read only by the server (service role).
--
-- ADDITIVE: one new table and three indexes. No existing object is touched. Nothing is called by applying this.
-- RLS is on with no policies, and anon/authenticated have no privileges at all. One transaction. Idempotent.
--
-- PRE-CHECK (must return NULL before applying):
--   SELECT to_regclass('public.ai_voice_calls');
--
-- VERIFY after applying:
--   SELECT has_table_privilege('anon','public.ai_voice_calls','SELECT'),
--          has_table_privilege('authenticated','public.ai_voice_calls','INSERT'),
--          has_table_privilege('service_role','public.ai_voice_calls','INSERT');   -- false, false, true
--   SELECT count(*) FROM pg_policies WHERE tablename = 'ai_voice_calls';          -- 0
--   SELECT count(*) FROM public.ai_voice_calls;                                   -- 0
--
-- Dry run: migrations/0201_ai_voice_calls.selftest.sql (self-rolling-back; ends by raising SELFTEST_OK 0201).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE IF NOT EXISTS public.ai_voice_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  device_hash text NULL,
  context text NOT NULL CONSTRAINT ai_voice_calls_context_check CHECK (context IN ('home', 'storefront', 'dashboard', 'admin')),
  mode text NOT NULL CONSTRAINT ai_voice_calls_mode_check CHECK (mode IN ('voice', 'video')),
  persona_id text NOT NULL,
  shop_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  conversation_id text,
  max_seconds integer NOT NULL,
  CONSTRAINT ai_voice_calls_identity_check CHECK (user_id IS NOT NULL OR device_hash IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ai_voice_calls_user_idx ON public.ai_voice_calls (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_voice_calls_device_idx ON public.ai_voice_calls (device_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_voice_calls_context_idx ON public.ai_voice_calls (context, created_at DESC);

ALTER TABLE public.ai_voice_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_voice_calls FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ai_voice_calls TO service_role;

COMMIT;
