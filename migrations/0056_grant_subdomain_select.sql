-- Migration: Allow anon/authenticated to read the new user_shops.subdomain column.
--
-- This project grants the anon/authenticated roles SELECT on a SPECIFIC LIST of
-- user_shops columns (deliberate: only expose storefront-safe columns publicly).
-- Column-level grants do NOT auto-include columns added later, so after migration
-- 0055 added `subdomain`, any SELECT that includes it fails with:
--   42501  permission denied for table user_shops
-- (the storefront's getShopBySlug now selects subdomain, hence "Failed to load shop").
--
-- subdomain is a public identifier (it's literally in the URL), so granting read
-- access is correct. Idempotent: harmless if a table-wide grant already covers it.

GRANT SELECT (subdomain) ON public.user_shops TO anon, authenticated;
