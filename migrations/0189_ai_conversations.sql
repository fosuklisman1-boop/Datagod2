-- 0189_ai_conversations.sql
--
-- AI assistant console, Task 3: redacted server-side transcripts of WEB AI chats. ADDITIVE; service-role only.
-- NOT applied by the implementing agent. One transaction. Idempotent (IF NOT EXISTS; re-runnable).
--
--   ai_conversations: one row per chat session (the widget's conversationKey uuid, one per session / "new chat").
--       UNIQUE (conversation_key): the key is a random uuid made per chat session, so one column is enough. The app
--       refuses to append when the stored context / user_id differ from the caller's, so presenting someone else's key
--       adds nothing. flagged / flag_reasons are set automatically (refusal, handoff, error, card_failed).
--   ai_conversation_messages: the redacted user / assistant texts (phones, emails, 6+ digit runs, card notes and tool
--       data fences are removed before insert; 4,000 chars max per message). ON DELETE CASCADE from the conversation,
--       which the daily retention cron deletes after 30 days of inactivity.
--   RLS on, no policies, every client privilege revoked: only service_role (BYPASSRLS) can read or write.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.ai_conversations'), to_regclass('public.ai_conversation_messages');   -- NULL, NULL
--   SELECT to_regclass('public.users');                                                              -- NOT NULL
--
-- VERIFY after applying:
--   SELECT has_table_privilege('anon','public.ai_conversations','SELECT'), has_table_privilege('authenticated','public.ai_conversation_messages','SELECT');  -- false, false
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_conversations'::regclass;             -- true
--
-- Dry run: migrations/0189_ai_conversations.selftest.sql (build the run string by code, as lib/ai-console/migration-0189.test.ts does).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.ai_conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_key uuid NOT NULL,
  context          text NOT NULL CHECK (context IN ('home','storefront','dashboard','admin')),
  user_id          uuid NULL REFERENCES public.users(id) ON DELETE CASCADE,
  shop_id          uuid NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  last_at          timestamptz NOT NULL DEFAULT now(),
  message_count    int NOT NULL DEFAULT 0,
  flagged          boolean NOT NULL DEFAULT false,
  flag_reasons     text[] NOT NULL DEFAULT '{}',
  reviewed_at      timestamptz NULL,
  reviewed_by      uuid NULL REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_conversations_key_uniq ON public.ai_conversations (conversation_key);
CREATE INDEX IF NOT EXISTS ai_conversations_last_at_idx ON public.ai_conversations (last_at DESC);
CREATE INDEX IF NOT EXISTS ai_conversations_flagged_idx ON public.ai_conversations (flagged, reviewed_at);

CREATE TABLE IF NOT EXISTS public.ai_conversation_messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant')),
  text            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_conversation_messages_conv_idx ON public.ai_conversation_messages (conversation_id, id);

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversation_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_conversations FROM anon, authenticated;
REVOKE ALL ON public.ai_conversation_messages FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.ai_conversation_messages_id_seq FROM anon, authenticated;
GRANT ALL ON public.ai_conversations TO service_role;
GRANT ALL ON public.ai_conversation_messages TO service_role;
GRANT ALL ON SEQUENCE public.ai_conversation_messages_id_seq TO service_role;

COMMIT;
