-- Bulk SMS foundation: tenant accounts, units ledger, bundle tiers.
-- One sms_account per user (admin = platform, shop owner = shop, sub-agent = sub_agent).
-- All balance mutations go through adjust_sms_units() (migration 0062) — never update
-- unit_balance directly.

CREATE TABLE IF NOT EXISTS sms_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('platform','shop','sub_agent')),
  owner_id      UUID,                       -- shop_id / sub_agent id; null for platform
  unit_balance  INT  NOT NULL DEFAULT 0 CHECK (unit_balance >= 0),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_unit_transactions (
  id             BIGSERIAL PRIMARY KEY,
  sms_account_id UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  delta          INT  NOT NULL,             -- +credit / -debit (in units = SMS segments)
  reason         TEXT NOT NULL,             -- bundle_wallet | bundle_paystack | admin_alloc | campaign_send | campaign_refund
  balance_after  INT  NOT NULL,
  ref            TEXT,                       -- idempotency / external ref (paystack ref, campaign id)
  campaign_id    UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_bundles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  units            INT  NOT NULL CHECK (units > 0),
  price_ghs        NUMERIC(10,2) NOT NULL CHECK (price_ghs >= 0),
  owner_type_scope TEXT NOT NULL DEFAULT 'all' CHECK (owner_type_scope IN ('all','shop','sub_agent','platform')),
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_unit_tx_account ON sms_unit_transactions(sms_account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_unit_tx_ref ON sms_unit_transactions(ref) WHERE ref IS NOT NULL;

-- RLS: owners read their own account + ledger; everyone reads active bundles.
-- Writes happen only via service-role (RLS-bypassing) routes/functions.
ALTER TABLE sms_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_unit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_bundles           ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_accounts_owner_select ON sms_accounts;
CREATE POLICY sms_accounts_owner_select ON sms_accounts
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS sms_unit_tx_owner_select ON sms_unit_transactions;
CREATE POLICY sms_unit_tx_owner_select ON sms_unit_transactions
  FOR SELECT TO authenticated USING (
    sms_account_id IN (SELECT id FROM sms_accounts WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS sms_bundles_read_active ON sms_bundles;
CREATE POLICY sms_bundles_read_active ON sms_bundles
  FOR SELECT TO authenticated USING (active = true);
