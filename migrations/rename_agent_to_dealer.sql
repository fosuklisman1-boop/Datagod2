-- Rename Airtime Fee keys in admin_settings to align with 'Dealer' terminology
UPDATE admin_settings 
SET key = REPLACE(key, '_agent', '_dealer')
WHERE key LIKE 'airtime_fee_%_agent';

-- Update descriptions if they exist
UPDATE admin_settings
SET description = REPLACE(description, 'Agent', 'Dealer')
WHERE key LIKE 'airtime_fee_%';
