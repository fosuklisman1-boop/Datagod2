-- Create AFA Registration Prices Table
CREATE TABLE IF NOT EXISTS afa_registration_prices (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE DEFAULT 'default',
  price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'GHS',
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

-- Enable Row Level Security
ALTER TABLE afa_registration_prices ENABLE ROW LEVEL SECURITY;

-- Create RLS Policies
-- Allow public read access for active prices
CREATE POLICY "Everyone can read active AFA prices" ON afa_registration_prices
  FOR SELECT
  USING (is_active = true);

-- Allow only service role and admins to update prices
CREATE POLICY "Only admins can update AFA prices" ON afa_registration_prices
  FOR UPDATE
  USING (
    (SELECT role FROM public.users WHERE id = auth.uid()) = 'admin'
  );

CREATE POLICY "Only admins can insert AFA prices" ON afa_registration_prices
  FOR INSERT
  WITH CHECK (
    (SELECT role FROM public.users WHERE id = auth.uid()) = 'admin'
  );

-- Insert default price
INSERT INTO afa_registration_prices (name, price, currency, description, is_active)
VALUES ('default', 50.00, 'GHS', 'Standard MTN AFA registration price', true)
ON CONFLICT (name) DO UPDATE SET 
  price = EXCLUDED.price,
  updated_at = NOW();
