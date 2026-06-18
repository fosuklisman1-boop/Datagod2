-- Follow-up to 20260618_fix_wassce_shop_markup_column.sql.
-- Now that the app is deployed and all code reads/writes results_checker_markup_wassce
-- (the data was backfilled from results_checker_markup_waec), drop the orphaned old column.
-- Idempotent.
ALTER TABLE user_shops DROP COLUMN IF EXISTS results_checker_markup_waec;
