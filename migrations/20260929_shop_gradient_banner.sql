-- Second brand color: the storefront hero becomes a two-color gradient card
-- (replacing the old flat single-color hero + section-divider cut). Owners
-- pick both colors explicitly in the Shop Profile wizard's Branding step.
ALTER TABLE user_shops
  ADD COLUMN IF NOT EXISTS custom_color_2 TEXT;

-- Same per-column grant requirement as custom_color/section_divider_style
-- (migrations/20260929_shop_profile_branding_and_community.sql) -- PostgREST
-- rejects the ENTIRE query for the anon role if even one selected column
-- lacks a grant, which silently 401s the whole public storefront.
GRANT SELECT (custom_color_2) ON public.user_shops TO anon;
