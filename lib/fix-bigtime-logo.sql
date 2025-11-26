-- Check current bigtime entry and update if needed
SELECT * FROM network_logos WHERE network_name = 'bigtime';

-- Update bigtime to use correct URL format
UPDATE network_logos 
SET logo_url = 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/bigtime.png'
WHERE network_name = 'bigtime';
