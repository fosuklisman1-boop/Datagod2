-- Adds real backing for the Shop Profile wizard's Branding and Community steps.
-- custom_color / section_divider_style: skin the public storefront hero.
-- community_link: shown as a "Join our community" button on the storefront,
-- same pattern as the existing shop_settings.whatsapp_link.

ALTER TABLE user_shops
  ADD COLUMN IF NOT EXISTS custom_color TEXT,
  ADD COLUMN IF NOT EXISTS section_divider_style TEXT;

ALTER TABLE shop_settings
  ADD COLUMN IF NOT EXISTS community_link TEXT;
