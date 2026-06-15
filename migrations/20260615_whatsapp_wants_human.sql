-- Flag conversations where the customer explicitly asked for a human, so the
-- inbox can surface them (badge + sorted first). The bot keeps answering; the
-- flag is a queue marker cleared when an admin engages (replies or takes over).
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS wants_human    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS wants_human_at TIMESTAMPTZ;
