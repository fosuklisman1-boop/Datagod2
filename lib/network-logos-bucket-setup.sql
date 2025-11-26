-- Create network_logos table (simplified - just store bucket paths)
CREATE TABLE IF NOT EXISTS network_logos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network_name VARCHAR(50) UNIQUE NOT NULL,
  logo_url TEXT NOT NULL, -- URL to image in storage bucket
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add RLS policy
ALTER TABLE network_logos ENABLE ROW LEVEL SECURITY;

-- Drop old column if it exists and add new one
ALTER TABLE network_logos DROP COLUMN IF EXISTS logo_data;

-- Make sure logo_url column exists
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name='network_logos' AND column_name='logo_url') THEN
    ALTER TABLE network_logos ADD COLUMN logo_url TEXT NOT NULL DEFAULT '';
  END IF;
END $$;

-- Public read access for network logos (drop if exists first)
DROP POLICY IF EXISTS "Public can read network logos" ON network_logos;
CREATE POLICY "Public can read network logos" ON network_logos
  FOR SELECT USING (true);

-- Insert default networks (you'll upload images to bucket after this)
INSERT INTO network_logos (network_name, logo_url) VALUES
('MTN', 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/mtn.jpeg'),
('Telecel', 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/telecel.png'),
('Vodafone', 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/vodafone.png'),
('AT', 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/at.png'),
('Airtel', 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/airtel.png'),
('iShare', 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/ishare.png')
ON CONFLICT (network_name) DO UPDATE SET logo_url = EXCLUDED.logo_url;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_network_logos_name ON network_logos(network_name);
