-- Create api_orders table to isolate programmatic purchases
CREATE TABLE api_orders (
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
  
  -- Prevent the same API user from duplicating an order reference
  CONSTRAINT unique_api_reference_per_user UNIQUE (user_id, api_reference)
);

-- RLS Policies
ALTER TABLE api_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own api orders"
  ON api_orders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Admins have full access to api orders"
  ON api_orders FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Function to inject api_orders into fulfillment flow
-- (The actual application logic will handle extending the cron jobs)
