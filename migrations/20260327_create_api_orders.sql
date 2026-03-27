-- 1. Create api_orders table safely
CREATE TABLE IF NOT EXISTS api_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id UUID NOT NULL REFERENCES user_api_keys(id) ON DELETE RESTRICT,
  network TEXT NOT NULL,
  volume_gb NUMERIC NOT NULL,
  price NUMERIC NOT NULL,
  recipient_phone TEXT NOT NULL,
  api_reference TEXT NOT NULL,
  provider_reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  CONSTRAINT unique_api_reference_per_user UNIQUE (user_id, api_reference)
);

-- 2. Safely add package_id if it's missing (for those who ran the first version)
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_orders' AND column_name='package_id') THEN
    ALTER TABLE api_orders ADD COLUMN package_id UUID REFERENCES packages(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. RLS Policies (Safe to re-run with DROP IF EXISTS)
ALTER TABLE api_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own api orders" ON api_orders;
CREATE POLICY "Users can view their own api orders" ON api_orders FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins have full access to api orders" ON api_orders;
CREATE POLICY "Admins have full access to api orders" ON api_orders FOR ALL USING (
  EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')
);
