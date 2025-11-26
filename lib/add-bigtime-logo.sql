-- Add bigtime network logo
INSERT INTO network_logos (network_name, logo_url) VALUES
('bigtime', 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/bigtime.png')
ON CONFLICT (network_name) DO UPDATE SET logo_url = EXCLUDED.logo_url;
