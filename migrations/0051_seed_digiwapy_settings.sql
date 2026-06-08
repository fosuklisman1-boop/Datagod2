-- Seed Digiwapy auto-fulfillment per-network toggle rows in admin_settings.
-- Defaults to disabled so admin must explicitly enable each network.
INSERT INTO admin_settings (key, value, description) VALUES
  ('airtime_digiwapy_enabled_mtn',     '{"enabled": false}', 'Auto-fulfill MTN airtime orders via Digiwapy API on payment'),
  ('airtime_digiwapy_enabled_telecel', '{"enabled": false}', 'Auto-fulfill Telecel airtime orders via Digiwapy API on payment'),
  ('airtime_digiwapy_enabled_at',      '{"enabled": false}', 'Auto-fulfill AT airtime orders via Digiwapy API on payment')
ON CONFLICT (key) DO NOTHING;
