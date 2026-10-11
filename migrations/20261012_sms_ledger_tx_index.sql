-- Speeds the per-account ledger lookups (reason filters, newest-first) used by the SMS customer pages.
BEGIN;
CREATE INDEX IF NOT EXISTS idx_sms_unit_tx_acct_reason_id ON sms_unit_transactions (sms_account_id, reason, id DESC);
COMMIT;
