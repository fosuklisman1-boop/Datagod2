-- Add combined network names for AT packages
INSERT INTO network_logos (network_name, logo_url) VALUES
('AT - iShare', 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/at.png'),
('AT - BigTime', 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/bigtime.png')
ON CONFLICT (network_name) DO UPDATE SET logo_url = EXCLUDED.logo_url;

-- Verify all networks
SELECT network_name, logo_url FROM network_logos ORDER BY network_name;
