INSERT INTO admin_settings (key, value, description) VALUES
  ('results_checker_price_waec',          '{"price": 5.00}',    'WAEC base price GHS'),
  ('results_checker_price_bece',          '{"price": 3.00}',    'BECE base price GHS'),
  ('results_checker_price_novdec',        '{"price": 4.00}',    'NOVDEC base price GHS'),
  ('results_checker_enabled_waec',        '{"enabled": true}',  'Enable WAEC voucher sales'),
  ('results_checker_enabled_bece',        '{"enabled": true}',  'Enable BECE voucher sales'),
  ('results_checker_enabled_novdec',      '{"enabled": false}', 'Enable NOVDEC voucher sales'),
  ('results_checker_max_markup_waec',     '{"max": 2.00}',      'Max flat markup GHS per WAEC voucher'),
  ('results_checker_max_markup_bece',     '{"max": 1.50}',      'Max flat markup GHS per BECE voucher'),
  ('results_checker_max_markup_novdec',   '{"max": 2.00}',      'Max flat markup GHS per NOVDEC voucher'),
  ('results_checker_max_quantity',        '{"max": 50}',        'Max vouchers per single order'),
  ('results_checker_reservation_timeout', '{"minutes": 10}',    'Voucher reservation timeout minutes')
ON CONFLICT (key) DO NOTHING;
