-- Storefront support for Results Check Service: customer info, shop attribution, markup
ALTER TABLE results_check_requests
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS customer_email text,
  ADD COLUMN IF NOT EXISTS shop_id uuid REFERENCES user_shops(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merchant_commission numeric(10,2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_results_check_requests_shop ON results_check_requests(shop_id);

-- Per-shop flat GHS markup on the results-check fee, capped by results_check_max_markup
ALTER TABLE user_shops
  ADD COLUMN IF NOT EXISTS results_check_markup NUMERIC(10,2) DEFAULT 0;

-- Admin cap (mirrors results_checker_max_markup_<board> pattern)
INSERT INTO admin_settings (key, value, description)
VALUES ('results_check_max_markup', '{"max": 5.00}'::jsonb, 'Max GHS markup shops can add to the Results Check Service fee')
ON CONFLICT (key) DO NOTHING;

-- shop_profits FK column for traceability (mirrors 0045_update_shop_profits_results_checker.sql)
ALTER TABLE shop_profits
  ADD COLUMN IF NOT EXISTS results_check_request_id uuid REFERENCES results_check_requests(id) ON DELETE SET NULL;
