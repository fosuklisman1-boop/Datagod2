-- Bulk pricing for results checker vouchers.
-- When a buyer (non-shop) purchases >= bulk_min_quantity vouchers of a given
-- board, the per-voucher price drops to bulk_price_{board} instead of the
-- regular results_checker_price_{board}.
-- Price of 0 = bulk pricing disabled for that board.

INSERT INTO admin_settings (key, value) VALUES
  ('results_checker_bulk_min_quantity', '{"min": 5}'),
  ('results_checker_bulk_price_waec',   '{"price": 0}'),
  ('results_checker_bulk_price_bece',   '{"price": 0}'),
  ('results_checker_bulk_price_novdec', '{"price": 0}')
ON CONFLICT (key) DO NOTHING;
