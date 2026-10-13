-- Public number customers message to reach the MAIN Datagod WhatsApp bot
-- (distinct from the shop bot, NEXT_PUBLIC_WHATSAPP_SHOP_NUMBER, and from
-- support_settings.support_whatsapp). Stored as international digits, e.g.
-- 233241234567. Empty = not configured (landing page hides the button).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS whatsapp_bot_number TEXT DEFAULT '';
