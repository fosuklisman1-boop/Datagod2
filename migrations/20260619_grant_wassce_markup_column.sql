-- HOTFIX: storefronts failed to open with 401 / "42501 permission denied for table
-- user_shops". user_shops uses COLUMN-LEVEL SELECT grants for the API roles, and the
-- results_checker_markup_wassce column added in 20260618_fix_wassce_shop_markup_column.sql
-- was never granted. The deployed storefront (getShopBySlug, anon key) selects it →
-- PostgREST denied the whole query. Grant SELECT on the new column to the API roles,
-- matching the existing results_checker_markup_* columns. Idempotent.
GRANT SELECT (results_checker_markup_wassce) ON user_shops TO anon;
GRANT SELECT (results_checker_markup_wassce) ON user_shops TO authenticated;
