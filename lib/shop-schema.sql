-- Shop Schema for Datagod2

-- 1. User Shops Table
CREATE TABLE IF NOT EXISTS user_shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_name VARCHAR(255) NOT NULL,
  shop_slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  logo_url VARCHAR(500),
  banner_url VARCHAR(500),
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id) -- One shop per user
);

-- 2. Shop Packages Table (Products for resale)
CREATE TABLE IF NOT EXISTS shop_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES packages(id),
  profit_margin DECIMAL(10, 2) NOT NULL, -- Profit added to base price
  custom_name VARCHAR(255), -- Optional custom name for the package
  is_available BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 3. Shop Orders Table (Customer purchases)
CREATE TABLE IF NOT EXISTS shop_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(20) NOT NULL,
  customer_name VARCHAR(255),
  shop_package_id UUID NOT NULL REFERENCES shop_packages(id),
  package_id UUID NOT NULL REFERENCES packages(id),
  network VARCHAR(50) NOT NULL,
  volume_gb DECIMAL(10, 2) NOT NULL,
  base_price DECIMAL(10, 2) NOT NULL,
  profit_amount DECIMAL(10, 2) NOT NULL,
  total_price DECIMAL(10, 2) NOT NULL, -- base_price + profit_amount
  order_status VARCHAR(50) DEFAULT 'pending', -- pending, processing, completed, failed, refunded
  payment_status VARCHAR(50) DEFAULT 'pending', -- pending, completed, failed
  transaction_id VARCHAR(255),
  reference_code VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 4. Shop Profits Table (Track profit accumulation)
CREATE TABLE IF NOT EXISTS shop_profits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  shop_order_id UUID NOT NULL REFERENCES shop_orders(id),
  profit_amount DECIMAL(10, 2) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending', -- pending, credited, withdrawn
  credited_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 5. Withdrawal Requests Table
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  amount DECIMAL(10, 2) NOT NULL,
  withdrawal_method VARCHAR(50) NOT NULL, -- bank_transfer, mobile_money, wallet
  account_details JSONB, -- Store bank or mobile money details
  status VARCHAR(50) DEFAULT 'pending', -- pending, approved, processing, completed, rejected
  rejection_reason TEXT,
  processed_at TIMESTAMP,
  completed_at TIMESTAMP,
  reference_code VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 6. Shop Settings Table (Optional for future features)
CREATE TABLE IF NOT EXISTS shop_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE UNIQUE,
  commission_rate DECIMAL(5, 2) DEFAULT 0, -- Platform commission percentage
  auto_approve_orders BOOLEAN DEFAULT false,
  notification_email VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_user_shops_user_id ON user_shops(user_id);
CREATE INDEX idx_user_shops_slug ON user_shops(shop_slug);
CREATE INDEX idx_shop_packages_shop_id ON shop_packages(shop_id);
CREATE INDEX idx_shop_orders_shop_id ON shop_orders(shop_id);
CREATE INDEX idx_shop_orders_status ON shop_orders(order_status);
CREATE INDEX idx_shop_profits_shop_id ON shop_profits(shop_id);
CREATE INDEX idx_withdrawal_requests_shop_id ON withdrawal_requests(shop_id);
CREATE INDEX idx_withdrawal_requests_status ON withdrawal_requests(status);

-- Row Level Security (RLS) Policies

-- Enable RLS
ALTER TABLE user_shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_profits ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_settings ENABLE ROW LEVEL SECURITY;

-- user_shops policies
CREATE POLICY "Users can view their own shop"
  ON user_shops FOR SELECT
  USING (auth.uid() = user_id OR is_active = true);

CREATE POLICY "Authenticated users can create a shop"
  ON user_shops FOR INSERT
  WITH CHECK (auth.uid() = user_id AND auth.uid() IS NOT NULL);

CREATE POLICY "Users can update their own shop"
  ON user_shops FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own shop"
  ON user_shops FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Public can view active shops by slug"
  ON user_shops FOR SELECT
  USING (is_active = true);

-- shop_packages policies
CREATE POLICY "Users can view their shop packages"
  ON shop_packages FOR SELECT
  USING (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create packages for their shop"
  ON shop_packages FOR INSERT
  WITH CHECK (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update their shop packages"
  ON shop_packages FOR UPDATE
  USING (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete their shop packages"
  ON shop_packages FOR DELETE
  USING (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Public can view available shop packages"
  ON shop_packages FOR SELECT
  USING (
    is_available = true AND
    shop_id IN (
      SELECT id FROM user_shops WHERE is_active = true
    )
  );

-- shop_orders policies
CREATE POLICY "Shop owners can view their orders"
  ON shop_orders FOR SELECT
  USING (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    ) OR auth.uid() IS NULL
  );

CREATE POLICY "Anyone can create a shop order"
  ON shop_orders FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Shop owners can update their orders"
  ON shop_orders FOR UPDATE
  USING (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Shop owners can delete their orders"
  ON shop_orders FOR DELETE
  USING (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

-- shop_profits policies
CREATE POLICY "Shop owners can view their profits"
  ON shop_profits FOR SELECT
  USING (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "System can create profit records"
  ON shop_profits FOR INSERT
  WITH CHECK (true);

CREATE POLICY "System can update profit records"
  ON shop_profits FOR UPDATE
  USING (true);

-- withdrawal_requests policies
CREATE POLICY "Users can view their withdrawal requests"
  ON withdrawal_requests FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can create withdrawal requests"
  ON withdrawal_requests FOR INSERT
  WITH CHECK (user_id = auth.uid() AND auth.uid() IS NOT NULL);

CREATE POLICY "Users can update their pending withdrawals"
  ON withdrawal_requests FOR UPDATE
  USING (user_id = auth.uid() AND status = 'pending');

CREATE POLICY "Admins can update all withdrawals"
  ON withdrawal_requests FOR UPDATE
  USING (true);

-- shop_settings policies
CREATE POLICY "Users can view their shop settings"
  ON shop_settings FOR SELECT
  USING (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create shop settings"
  ON shop_settings FOR INSERT
  WITH CHECK (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update their shop settings"
  ON shop_settings FOR UPDATE
  USING (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete their shop settings"
  ON shop_settings FOR DELETE
  USING (
    shop_id IN (
      SELECT id FROM user_shops WHERE user_id = auth.uid()
    )
  );

-- Helper Functions

-- Function to calculate available balance
CREATE OR REPLACE FUNCTION get_shop_available_balance(p_shop_id UUID)
RETURNS DECIMAL AS $$
SELECT COALESCE(SUM(profit_amount), 0)
FROM shop_profits
WHERE shop_id = p_shop_id AND status = 'pending'
$$ LANGUAGE SQL STABLE;

-- Function to get total profit
CREATE OR REPLACE FUNCTION get_shop_total_profit(p_shop_id UUID)
RETURNS DECIMAL AS $$
SELECT COALESCE(SUM(profit_amount), 0)
FROM shop_profits
WHERE shop_id = p_shop_id AND status IN ('pending', 'credited')
$$ LANGUAGE SQL STABLE;

-- Function to create shop for new user
CREATE OR REPLACE FUNCTION create_default_shop(p_user_id UUID, p_email VARCHAR)
RETURNS UUID AS $$
DECLARE
  v_shop_id UUID;
  v_shop_slug VARCHAR;
BEGIN
  v_shop_slug := 'shop-' || substring(p_user_id::text, 1, 8);
  
  INSERT INTO user_shops (user_id, shop_name, shop_slug, description)
  VALUES (p_user_id, 'My Shop', v_shop_slug, 'Welcome to my shop')
  RETURNING id INTO v_shop_id;
  
  RETURN v_shop_id;
END;
$$ LANGUAGE plpgsql;
