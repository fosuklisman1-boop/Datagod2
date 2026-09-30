-- Lets a shop owner set a dedicated, word-filtered name for their shop's
-- USSD header, separate from the unrestricted shop_name (which has zero
-- content validation and is otherwise used on the web storefront etc).
-- See docs/superpowers/specs/2026-09-30-ussd-shop-display-name-design.md.
-- NULL means "keep showing shop_name, unchanged" -- no backfill needed.
ALTER TABLE user_shops ADD COLUMN IF NOT EXISTS ussd_display_name TEXT;
