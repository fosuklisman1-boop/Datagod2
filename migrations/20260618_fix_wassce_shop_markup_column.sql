-- Fix: shop owners' WASSCE results-checker voucher markups were never applied.
--
-- The runtime board key is 'wassce' (calculateRCPrice in lib/results-checker-service.ts,
-- the storefront forms, and the my-shop cap lookup all use examBoard.toLowerCase()), but
-- the WAEC→WASSCE rename never renamed the user_shops markup COLUMN. It stayed
-- `results_checker_markup_waec`, so the code read `results_checker_markup_wassce`
-- (nonexistent) → the select returned nothing → markupPerVoucher stayed 0 for WASSCE.
-- BECE/NOVDEC have matching columns, so they worked. Any WASSCE markup a shop set was
-- stranded in the old _waec column and ignored by pricing.
--
-- Zero-downtime (expand): ADD the wassce-named column and backfill from _waec. This makes
-- pricing pick up existing WASSCE markups IMMEDIATELY, without breaking code still selecting
-- _waec. After the code deploy (which now reads/writes _wassce everywhere), the now-orphaned
-- _waec column can be dropped in a follow-up:
--     ALTER TABLE user_shops DROP COLUMN results_checker_markup_waec;
-- Idempotent / safe to re-run.

ALTER TABLE user_shops
  ADD COLUMN IF NOT EXISTS results_checker_markup_wassce numeric;

UPDATE user_shops
  SET results_checker_markup_wassce = results_checker_markup_waec
  WHERE results_checker_markup_wassce IS DISTINCT FROM results_checker_markup_waec;

-- The WASSCE markup cap was mis-set to 5 during the rename while every other board (and the
-- old _waec key) is 20. Restore parity so shops aren't silently clamped below the others.
UPDATE admin_settings
  SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{max}', '20'::jsonb)
  WHERE key = 'results_checker_max_markup_wassce';
