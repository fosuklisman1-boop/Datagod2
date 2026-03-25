-- Create airtime_download_batches table to track airtime order exports
CREATE TABLE IF NOT EXISTS airtime_download_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network VARCHAR(50) NOT NULL,
  batch_time TIMESTAMP WITH TIME ZONE NOT NULL,
  orders JSONB NOT NULL DEFAULT '[]'::jsonb,
  order_count INTEGER DEFAULT 0,
  downloaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  downloaded_by_email TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_airtime_download_batches_network ON airtime_download_batches(network);
CREATE INDEX IF NOT EXISTS idx_airtime_download_batches_batch_time ON airtime_download_batches(batch_time);

-- Enable RLS
ALTER TABLE airtime_download_batches ENABLE ROW LEVEL SECURITY;

-- Admin-only policies
CREATE POLICY "Admins can do everything on airtime_download_batches" 
ON airtime_download_batches 
FOR ALL 
TO authenticated 
USING (auth.jwt() ->> 'role' = 'admin')
WITH CHECK (auth.jwt() ->> 'role' = 'admin');
