-- Separate WhatsApp community GROUP link, distinct from join_community_link
-- (which in practice holds a WhatsApp CHANNEL url). Landing page shows both.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS join_group_link TEXT DEFAULT '';
