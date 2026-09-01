-- Admin-configurable kill switch for specific admin SMS alert types, read by
-- notifyAdmins() in lib/sms-service.ts. Disables the two operational-noise
-- categories the user asked to turn off (low balance, fulfillment/order
-- failures) while leaving fraud/security SMS types (price_manipulation,
-- payment_mismatch, airtime_fraud_alert) untouched — those never get added
-- to this list unless explicitly requested.
--
-- Push notifications (notifyAdminsPush) and email fallback are NOT affected
-- by this setting — it only gates the SMS channel inside notifyAdmins().
INSERT INTO admin_settings (key, value, updated_at)
VALUES (
  'disabled_sms_alert_types',
  jsonb_build_object('types', jsonb_build_array('balance_alert', 'fulfillment_failure')),
  now()
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
