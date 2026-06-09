-- Rename exam board 'WAEC' → 'WASSCE' across all tables and settings.
-- WAEC is the organisation; WASSCE is the actual exam name.
-- Safe to re-run — UPDATE WHERE is idempotent once values are already renamed.

-- Voucher inventory
UPDATE results_checker_inventory
  SET exam_board = 'WASSCE', updated_at = now()
  WHERE exam_board = 'WAEC';

-- Voucher purchase orders
UPDATE results_checker_orders
  SET exam_board = 'WASSCE', updated_at = now()
  WHERE exam_board = 'WAEC';

-- Results check service requests
UPDATE results_check_requests
  SET exam_board = 'WASSCE', updated_at = now()
  WHERE exam_board = 'WAEC';

-- Admin settings: enabled flag
UPDATE admin_settings
  SET key = 'results_checker_enabled_wassce', updated_at = now()
  WHERE key = 'results_checker_enabled_waec';

-- Admin settings: price
UPDATE admin_settings
  SET key = 'results_checker_price_wassce', updated_at = now()
  WHERE key = 'results_checker_price_waec';

-- Admin settings: bulk price threshold and price (common key patterns)
UPDATE admin_settings
  SET key = replace(key, '_waec_', '_wassce_'), updated_at = now()
  WHERE key LIKE '%_waec_%';

UPDATE admin_settings
  SET key = replace(key, '_waec', '_wassce'), updated_at = now()
  WHERE key LIKE '%_waec';
