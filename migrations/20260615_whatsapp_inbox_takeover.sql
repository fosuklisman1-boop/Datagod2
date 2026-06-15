-- Admin WhatsApp Inbox: human-takeover state on each conversation.
--
-- When human_takeover is true the inbound webhook suppresses the bot/AI so an
-- admin can handle the chat manually. taken_over_at doubles as a heartbeat —
-- set on take-over and bumped on every admin reply; a takeover is treated as
-- active only while now - taken_over_at < 30 min (auto-resume on admin idle,
-- evaluated lazily in the webhook, no cron). The flag lives here (not the Redis
-- session, which has a 30-min TTL) so it survives across sessions.
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS human_takeover BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS taken_over_by  UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS taken_over_at  TIMESTAMPTZ;

-- The webhook only ever filters "is this phone currently taken over?".
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_takeover
  ON whatsapp_conversations(phone_number) WHERE human_takeover = TRUE;
