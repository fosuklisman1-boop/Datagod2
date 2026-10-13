-- SMS provider control: per-send provider choice persisted so retries (drain/held/scheduled) honour it.
-- Do NOT apply automatically; code tolerates the columns being absent until this is run.
ALTER TABLE sms_send_logs ADD COLUMN IF NOT EXISTS provider_override text CHECK (provider_override IN ('moolre','hubtel'));
ALTER TABLE broadcast_logs ADD COLUMN IF NOT EXISTS sms_provider text CHECK (sms_provider IN ('moolre','hubtel','global'));
