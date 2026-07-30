-- app_settings shares one table between a singleton global-config row (key IS NULL)
-- and true key-value rows (e.g. mtn_balance_alert_threshold). Nothing previously
-- prevented a second key-IS-NULL row from being created (e.g. via a race between
-- concurrent GET/PUT requests), which broke every .single() query against the
-- singleton row and caused runaway duplicate-row creation. This makes a second
-- key-IS-NULL row structurally impossible.
CREATE UNIQUE INDEX IF NOT EXISTS app_settings_singleton_null_key
ON app_settings ((key IS NULL))
WHERE key IS NULL;
