-- 0202_ai_voice_calls_nuance_key.sql
-- Clings voice calls: record which Nuance account (1..9) a call was minted on, so the token route can skip an
-- account whose call slots are full when several accounts are in use (Nuance beta, admin switch voice.multiAccount).
-- Additive, nullable, no backfill. Old rows stay NULL (= unknown account).
--
-- PRE-CHECK:  select to_regclass('public.ai_voice_calls');  -- must exist (0201)
-- VERIFY:     select column_name, data_type from information_schema.columns
--               where table_schema='public' and table_name='ai_voice_calls' and column_name='nuance_key';

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.ai_voice_calls
  ADD COLUMN IF NOT EXISTS nuance_key smallint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_voice_calls_nuance_key_range') THEN
    ALTER TABLE public.ai_voice_calls
      ADD CONSTRAINT ai_voice_calls_nuance_key_range CHECK (nuance_key IS NULL OR nuance_key BETWEEN 1 AND 9);
  END IF;
END $$;

-- Open calls per account: the token route reads rows with ended_at IS NULL inside the last max_seconds + 60 s.
CREATE INDEX IF NOT EXISTS ai_voice_calls_open_key_idx
  ON public.ai_voice_calls (nuance_key, created_at DESC) WHERE ended_at IS NULL;

COMMIT;
