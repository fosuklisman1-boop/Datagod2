-- 0203_ai_voice_queue.sql
-- Clings voice calls: a waiting line for when every Nuance account's call slot is taken. A ticket is one caller
-- (signed-in user or device) waiting for a slot; the check-in route admits the first in line when a slot frees up.
-- New table only, no backfill. Service role only (RLS on, no policies, client roles revoked).
--
-- PRE-CHECK:  select to_regclass('public.ai_voice_queue');  -- must be NULL before the first apply
-- VERIFY:     select column_name, data_type from information_schema.columns
--               where table_schema='public' and table_name='ai_voice_queue' order by ordinal_position;

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE IF NOT EXISTS public.ai_voice_queue (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_hash   text        NULL,
  context       text        NOT NULL CHECK (context IN ('home', 'storefront', 'dashboard', 'admin')),
  mode          text        NOT NULL CHECK (mode IN ('voice', 'video')),
  status        text        NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'admitted', 'used', 'left', 'expired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  admitted_at   timestamptz NULL,
  CONSTRAINT ai_voice_queue_identity CHECK (user_id IS NOT NULL OR device_hash IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ai_voice_queue_status_created_idx
  ON public.ai_voice_queue (status, created_at);

ALTER TABLE public.ai_voice_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_voice_queue FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ai_voice_queue TO service_role;

COMMIT;
