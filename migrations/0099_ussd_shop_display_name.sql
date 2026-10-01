-- Lets a shop owner set a dedicated, word-filtered name for their shop's
-- USSD header, separate from the unrestricted shop_name (which has zero
-- content validation and is otherwise used on the web storefront etc).
-- See docs/superpowers/specs/2026-09-30-ussd-shop-display-name-design.md.
-- NULL means "keep showing shop_name, unchanged" -- no backfill needed.
ALTER TABLE user_shops ADD COLUMN IF NOT EXISTS ussd_display_name TEXT;

-- Defense in depth: user_shops' owner RLS policy (see migrations/0037) grants
-- UPDATE with no column restriction, so a shop owner could otherwise write
-- ussd_display_name directly (bypassing the app-level validation in
-- lib/ussd-display-name.ts entirely, e.g. via a raw PostgREST PATCH). This
-- CHECK constraint mirrors that module's rules at the DB level: trimmed
-- (no stored leading/trailing whitespace), 1-30 chars, and none of the
-- blocked words as a whole word (case-insensitive; \m/\M are Postgres'
-- word-boundary anchors, equivalent to \b in the TS regex). Keep this list
-- in sync with lib/ussd-display-name.ts's BLOCKED_WORDS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'user_shops_ussd_display_name_check'
  ) THEN
    ALTER TABLE user_shops
      ADD CONSTRAINT user_shops_ussd_display_name_check
      CHECK (
        ussd_display_name IS NULL OR (
          ussd_display_name = btrim(ussd_display_name)
          AND char_length(ussd_display_name) BETWEEN 1 AND 30
          AND ussd_display_name !~* '\m(data|bundles?|mtn|telecel|airteltigo|at)\M'
        )
      );
  END IF;
END $$;
