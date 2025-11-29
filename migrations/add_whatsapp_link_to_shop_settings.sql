-- Add whatsapp_link column to shop_settings if it doesn't exist
ALTER TABLE shop_settings
ADD COLUMN IF NOT EXISTS whatsapp_link VARCHAR(500);
