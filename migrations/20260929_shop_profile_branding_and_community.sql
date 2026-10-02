-- Adds real backing for the Shop Profile wizard's Branding and Community steps.
-- custom_color / section_divider_style: skin the public storefront hero.
-- community_link: shown as a "Join our community" button on the storefront,
-- same pattern as the existing shop_settings.whatsapp_link.

ALTER TABLE user_shops
  ADD COLUMN IF NOT EXISTS custom_color TEXT,
  ADD COLUMN IF NOT EXISTS section_divider_style TEXT;

ALTER TABLE shop_settings
  ADD COLUMN IF NOT EXISTS community_link TEXT;

-- This project grants SELECT per-column, not per-table -- a newly added
-- column has NO grants until explicitly given them. getShopBySlug() (the
-- public storefront's lookup) runs as `anon` and selects custom_color +
-- section_divider_style; without this grant the whole query 401s for every
-- shop, not just branded ones -- PostgREST rejects the entire row if any
-- selected column lacks a grant. shop_settings.community_link doesn't need
-- an anon grant: it's only ever read through the service-role
-- /api/shop/settings/[shopId] route, never a direct anon query.
-- (Caught live 2026-09-29 via a broken storefront preview link.)
GRANT SELECT (custom_color, section_divider_style) ON public.user_shops TO anon;
