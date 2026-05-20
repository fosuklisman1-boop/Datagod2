-- Flat GHS markup per voucher that the shop charges on top of the base price.
-- e.g. results_checker_markup_waec = 1.50 means the shop adds GHS 1.50 per WAEC card.
-- Admin settings define the ceiling per board (results_checker_max_markup_{board}).
ALTER TABLE user_shops
  ADD COLUMN IF NOT EXISTS results_checker_markup_waec   NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS results_checker_markup_bece   NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS results_checker_markup_novdec NUMERIC(10,2) DEFAULT 0;
