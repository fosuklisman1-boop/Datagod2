-- Store the customer's WhatsApp display name (from the inbound webhook's
-- contacts[0].profile.name) so guest conversations show a real name + avatar
-- initials instead of just the phone number. WhatsApp Cloud API does NOT expose
-- profile photos, so the name is the most we can capture.
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS wa_profile_name text;
