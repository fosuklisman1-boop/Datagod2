-- Update MTN logo URL to use .jpeg extension
UPDATE network_logos 
SET logo_url = 'https://riijesduargxlzxuperj.supabase.co/storage/v1/object/public/network-logos/mtn.jpeg'
WHERE network_name = 'MTN';
