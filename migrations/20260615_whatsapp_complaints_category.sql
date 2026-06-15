-- Complaint category so the bot can gather type-appropriate details and admins
-- can triage at a glance: data | airtime | afa | results | wallet_topup | other.
-- Wallet top-up complaints differ from data/airtime (no beneficiary number; it's
-- about the payment reference/MoMo number, amount and proof against the
-- customer's own account).
ALTER TABLE whatsapp_complaints
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other';
