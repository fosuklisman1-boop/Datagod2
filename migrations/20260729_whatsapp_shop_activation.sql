-- WhatsApp shop activation — a one-time unlock fee per shop code (separate from
-- USSD session tokens, which remain shared). whatsapp_activated gates whether a
-- shop code can be used on the WhatsApp shop bot; whatsapp_activated_at records
-- when it was paid. is_whatsapp_activation marks a ussd_shop_token_purchases row
-- as a WhatsApp-activation charge (tokens_purchased=0 for these — no sessions
-- are granted, only the unlock flag).
ALTER TABLE public.ussd_shop_codes
  ADD COLUMN IF NOT EXISTS whatsapp_activated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_activated_at TIMESTAMPTZ;

ALTER TABLE public.ussd_shop_token_purchases
  ADD COLUMN IF NOT EXISTS is_whatsapp_activation BOOLEAN NOT NULL DEFAULT false;
