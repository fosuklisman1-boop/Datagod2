-- Admin-controlled toggle: whether the "Dial our USSD code" advertisement
-- card renders on web storefronts (app/shop/[slug]). Defaults OFF since this
-- is a new, previously-nonexistent storefront surface -- an admin opts in
-- once they're ready, rather than every shop's page changing silently.
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS storefront_show_ussd_card BOOLEAN NOT NULL DEFAULT false;
