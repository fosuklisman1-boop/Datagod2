-- Shop slug history — lets old storefront links keep working after a slug
-- rotation/rename. When a shop's public slug changes, the OLD slug is appended
-- to previous_slugs; a visit to /shop/<old-slug> then resolves to the shop's
-- CURRENT slug and redirects there (see app/api/shop/resolve-alias).
--
-- Resolution goes through the service-role route (service_role bypasses grants),
-- so NO anon/authenticated grant is added here — the column stays private, which
-- also keeps it out of the public getShopBySlug projection.
ALTER TABLE user_shops
  ADD COLUMN IF NOT EXISTS previous_slugs TEXT[] NOT NULL DEFAULT '{}';

-- GIN index for fast containment lookups (slug = ANY(previous_slugs)).
CREATE INDEX IF NOT EXISTS idx_user_shops_previous_slugs
  ON user_shops USING GIN (previous_slugs);
