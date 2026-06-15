-- Structured details for WhatsApp complaints, mirroring the web complaint modal
-- (which captures the order, the recipient/beneficiary number, and payment/balance
-- evidence screenshots). beneficiary_number + order_info are gathered by the bot;
-- evidence_urls accumulates screenshots the customer sends (captured by the webhook).
ALTER TABLE whatsapp_complaints
  ADD COLUMN IF NOT EXISTS beneficiary_number TEXT,
  ADD COLUMN IF NOT EXISTS order_info         TEXT,
  ADD COLUMN IF NOT EXISTS evidence_urls      JSONB NOT NULL DEFAULT '[]'::jsonb;
