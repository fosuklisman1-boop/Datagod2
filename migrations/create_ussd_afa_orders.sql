-- USSD AFA registrations — paid via Paystack MoMo (no wallet/user account needed)
CREATE TABLE IF NOT EXISTS ussd_afa_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dialing_phone       VARCHAR(20)   NOT NULL,
  full_name           VARCHAR(255)  NOT NULL,
  gh_card_number      VARCHAR(50)   NOT NULL,
  location            VARCHAR(255)  NOT NULL,
  region              VARCHAR(100)  NOT NULL,
  occupation          VARCHAR(100)  NOT NULL DEFAULT 'Farmer',
  amount              DECIMAL(10,2) NOT NULL,
  payment_status      VARCHAR(50)   NOT NULL DEFAULT 'pending'
                        CHECK (payment_status IN ('pending','completed','failed')),
  paystack_reference  VARCHAR(255),
  order_status        VARCHAR(50)   NOT NULL DEFAULT 'pending'
                        CHECK (order_status IN ('pending','processing','completed','failed')),
  fulfillment_status  VARCHAR(50)   NOT NULL DEFAULT 'unfulfilled'
                        CHECK (fulfillment_status IN ('unfulfilled','pending','fulfilled','failed')),
  fulfillment_ref     VARCHAR(255),
  fulfillment_error   TEXT,
  fulfilled_at        TIMESTAMPTZ,
  fulfillment_attempts INT          NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ussd_afa_orders_dialing_phone_idx ON ussd_afa_orders (dialing_phone);
CREATE INDEX IF NOT EXISTS ussd_afa_orders_payment_status_idx ON ussd_afa_orders (payment_status);
CREATE INDEX IF NOT EXISTS ussd_afa_orders_order_status_idx   ON ussd_afa_orders (order_status);
CREATE INDEX IF NOT EXISTS ussd_afa_orders_paystack_ref_idx   ON ussd_afa_orders (paystack_reference);
