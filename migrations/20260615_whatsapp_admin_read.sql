-- Track when an ADMIN last opened a conversation, so "unread" means "the
-- customer messaged since an admin looked" — independent of the bot's
-- auto-replies (which would otherwise instantly clear the unread state via
-- latest_outbound_at). unread = latest_inbound_at > admin_read_at (or never read).
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS admin_read_at timestamptz;
