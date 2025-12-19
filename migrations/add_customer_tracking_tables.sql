-- Create shop_customers table to track unique customers per shop
CREATE TABLE IF NOT EXISTS shop_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  email VARCHAR(255),
  customer_name VARCHAR(255),
  
  -- Tracking metrics
  first_purchase_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_purchase_at TIMESTAMP NOT NULL DEFAULT NOW(),
  total_purchases INTEGER DEFAULT 1,
  total_spent DECIMAL(12,2) DEFAULT 0,
  repeat_customer BOOLEAN DEFAULT FALSE,
  
  -- Analytics
  first_source_slug VARCHAR(255),
  preferred_network VARCHAR(50),
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Unique constraint: one customer per shop per phone number
  UNIQUE(shop_id, phone_number)
);

-- Create customer_tracking table for detailed tracking
CREATE TABLE IF NOT EXISTS customer_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_order_id UUID NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  shop_customer_id UUID NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  
  -- Tracking details
  accessed_via_slug VARCHAR(255),
  accessed_at TIMESTAMP DEFAULT NOW(),
  purchase_completed BOOLEAN DEFAULT FALSE,
  
  -- Optional: UTM parameters for analytics
  referrer VARCHAR(255),
  utm_source VARCHAR(255),
  utm_medium VARCHAR(255),
  utm_campaign VARCHAR(255),
  
  created_at TIMESTAMP DEFAULT NOW()
);

-- Modify shop_orders table to link to customers
ALTER TABLE shop_orders
ADD COLUMN IF NOT EXISTS shop_customer_id UUID REFERENCES shop_customers(id) ON DELETE SET NULL;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_shop_customers_shop_id ON shop_customers(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_customers_repeat_customer ON shop_customers(repeat_customer);
CREATE INDEX IF NOT EXISTS idx_shop_customers_last_purchase_at ON shop_customers(last_purchase_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_customers_created_at ON shop_customers(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_tracking_shop_id ON customer_tracking(shop_id);
CREATE INDEX IF NOT EXISTS idx_customer_tracking_customer_id ON customer_tracking(shop_customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_tracking_slug ON customer_tracking(accessed_via_slug);
CREATE INDEX IF NOT EXISTS idx_customer_tracking_accessed_at ON customer_tracking(accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_shop_orders_customer_id ON shop_orders(shop_customer_id);

-- Enable Row Level Security
ALTER TABLE shop_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_tracking ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Shop owners can view their own customers
CREATE POLICY "Shop owners can view their customers"
  ON shop_customers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_shops
      WHERE user_shops.id = shop_customers.shop_id
      AND user_shops.user_id = auth.uid()
    )
  );

-- RLS Policy: Shop owners can view their customer tracking data
CREATE POLICY "Shop owners can view their customer tracking"
  ON customer_tracking FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_shops
      WHERE user_shops.id = customer_tracking.shop_id
      AND user_shops.user_id = auth.uid()
    )
  );

-- Comments for documentation
COMMENT ON TABLE shop_customers IS 'Stores unique customer records per shop with aggregated purchase metrics';
COMMENT ON TABLE customer_tracking IS 'Tracks detailed information about each purchase including which slug was used';
COMMENT ON COLUMN shop_customers.phone_number IS 'Primary identifier for customers (unique per shop)';
COMMENT ON COLUMN shop_customers.repeat_customer IS 'Boolean flag: true if customer has made more than 1 purchase';
COMMENT ON COLUMN shop_customers.total_spent IS 'Cumulative amount spent by customer (LTV)';
COMMENT ON COLUMN customer_tracking.accessed_via_slug IS 'The shop slug used when customer accessed the storefront';
