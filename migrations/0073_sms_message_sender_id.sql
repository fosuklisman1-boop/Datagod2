-- migrations/0073_sms_message_sender_id.sql
-- Wire the per-account chosen sender ID through the metered send pipeline so
-- campaigns send from the tenant's own Moolre-registered sender ID (spec §3/§5:
-- "Campaigns may only select an active sender ID").
--
-- sms_send_logs.sender_id already exists (0067, "chosen sender (M5)"). The
-- per-recipient queue did not carry it. claim_sms_messages RETURNS SETOF
-- sms_messages (RETURNING m.*), so adding the column surfaces it to the drain
-- with NO function change. Nullable → NULL falls back to the platform default
-- (MOOLRE_SENDER_ID) in sendSMSViaMoolre, so existing sends are unaffected.

ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS sender_id TEXT;
