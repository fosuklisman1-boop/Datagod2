-- Migration: Add a clean `subdomain` identifier to user_shops.
--
-- Shops are reachable today at /shop/<shop_slug>, where shop_slug carries a random
-- suffix for uniqueness (e.g. my-shop-abc1def). This adds a clean, memorable subdomain
-- (my-shop.datagod.store) without the random suffix. shop_slug is KEPT for back-compat;
-- lookups match EITHER column so existing links never break.
--
-- Collisions resolve with a numeric suffix: first shop -> "data", next -> "data-2", ...

-- 1. Column (nullable for now; backfilled below, then set NOT NULL).
ALTER TABLE user_shops ADD COLUMN IF NOT EXISTS subdomain VARCHAR(255) UNIQUE;

-- 2. Helper: returns an available subdomain derived from a shop name.
--    Tries base slug, then base-2, base-3, ... until one is free.
CREATE OR REPLACE FUNCTION generate_unique_subdomain(base_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  base_slug TEXT;
  candidate TEXT;
  counter   INTEGER := 0;
BEGIN
  base_slug := lower(regexp_replace(base_name, '[^a-zA-Z0-9]+', '-', 'g'));
  base_slug := trim(both '-' from base_slug);

  IF length(base_slug) < 2 THEN
    base_slug := 'shop';
  END IF;

  LOOP
    -- counter = 0 -> "base"; counter = 1 -> "base-2"; counter = 2 -> "base-3"; ...
    candidate := CASE WHEN counter = 0 THEN base_slug ELSE base_slug || '-' || (counter + 1) END;

    IF NOT EXISTS (SELECT 1 FROM user_shops WHERE subdomain = candidate) THEN
      RETURN candidate;
    END IF;

    counter := counter + 1;
    IF counter > 999 THEN
      RAISE EXCEPTION 'Could not generate a unique subdomain after 999 attempts';
    END IF;
  END LOOP;
END;
$$;

-- 3. Backfill existing shops with clean subdomains from shop_name.
--    Ordered by created_at so the first-created shop gets the cleanest (un-suffixed) slug.
DO $$
DECLARE
  shop_row  RECORD;
  clean_sub TEXT;
BEGIN
  FOR shop_row IN
    SELECT id, shop_name FROM user_shops
    WHERE subdomain IS NULL
    ORDER BY created_at ASC
  LOOP
    clean_sub := generate_unique_subdomain(shop_row.shop_name);
    UPDATE user_shops SET subdomain = clean_sub WHERE id = shop_row.id;
  END LOOP;
END $$;

-- 4. Enforce NOT NULL after backfill.
ALTER TABLE user_shops ALTER COLUMN subdomain SET NOT NULL;

-- 5. Index — middleware/storefront lookups query this column on every request.
CREATE INDEX IF NOT EXISTS idx_user_shops_subdomain ON user_shops(subdomain);

-- 6. Auto-assign a subdomain on new shops when not explicitly provided.
--    Keeps subdomain assignment atomic and race-safe at the DB layer, so client
--    shop-creation code doesn't need to compute uniqueness itself.
CREATE OR REPLACE FUNCTION set_shop_subdomain()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.subdomain IS NULL THEN
    NEW.subdomain := generate_unique_subdomain(NEW.shop_name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_shop_subdomain ON user_shops;
CREATE TRIGGER trg_set_shop_subdomain
  BEFORE INSERT ON user_shops
  FOR EACH ROW EXECUTE FUNCTION set_shop_subdomain();
