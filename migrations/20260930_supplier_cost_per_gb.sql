-- Admin-configurable wholesale cost per GB, per network -- lets the admin
-- dashboard compute a real platform profit (revenue minus what we actually
-- pay suppliers for data), instead of only the gross-margin proxy.
-- Same per-network column pattern as price_adjustment_mtn/telecel/at_ishare/
-- at_bigtime on this same table.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS supplier_cost_per_gb_mtn NUMERIC(10, 4) DEFAULT 0;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS supplier_cost_per_gb_telecel NUMERIC(10, 4) DEFAULT 0;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS supplier_cost_per_gb_at_ishare NUMERIC(10, 4) DEFAULT 0;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS supplier_cost_per_gb_at_bigtime NUMERIC(10, 4) DEFAULT 0;

COMMENT ON COLUMN app_settings.supplier_cost_per_gb_mtn IS 'GHS wholesale cost per GB Datagod pays its MTN supplier(s). Admin-editable, used for real profit calculation.';
COMMENT ON COLUMN app_settings.supplier_cost_per_gb_telecel IS 'GHS wholesale cost per GB Datagod pays its Telecel supplier(s).';
COMMENT ON COLUMN app_settings.supplier_cost_per_gb_at_ishare IS 'GHS wholesale cost per GB Datagod pays its AT - iShare supplier(s).';
COMMENT ON COLUMN app_settings.supplier_cost_per_gb_at_bigtime IS 'GHS wholesale cost per GB Datagod pays its AT - BigTime supplier(s).';
