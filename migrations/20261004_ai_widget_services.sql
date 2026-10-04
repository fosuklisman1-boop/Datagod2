-- Replaces the flat ai_widget_enabled boolean with a per-service enable
-- list, so admin can turn the AI assistant on/off independently for each
-- product area instead of one global switch. A shop storefront's widget
-- then only shows when at least one of ITS OWN allowed services (see
-- lib/custom-domains.ts's DomainService -- null/unrestricted counts as "all
-- services") is also AI-enabled here; the customer dashboard widget (not
-- tied to any one shop's services) shows as long as this list isn't empty.
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS ai_widget_services TEXT[] DEFAULT ARRAY['data_bundles', 'airtime', 'results_checker', 'bulk_sms'];

-- Preserve the previous all-or-nothing value: ai_widget_enabled = true means
-- every service was effectively enabled, false means none were.
UPDATE app_settings
SET ai_widget_services = CASE WHEN ai_widget_enabled THEN ARRAY['data_bundles', 'airtime', 'results_checker', 'bulk_sms'] ELSE ARRAY[]::TEXT[] END
WHERE key IS NULL;

ALTER TABLE app_settings
  DROP COLUMN IF EXISTS ai_widget_enabled;
