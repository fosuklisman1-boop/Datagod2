-- Fix logo and banner URL column sizes for base64 encoded images
-- Run this in Supabase SQL Editor

ALTER TABLE user_shops 
  ALTER COLUMN logo_url TYPE TEXT,
  ALTER COLUMN banner_url TYPE TEXT;
