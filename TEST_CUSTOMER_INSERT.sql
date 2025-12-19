-- Diagnostic SQL to test customer tracking

-- Step 1: Get your actual shop ID
SELECT id, user_id, shop_name FROM user_shops LIMIT 5;

-- Step 2: Copy the ID from step 1 and use it in the query below
-- Replace 'paste-your-shop-id-here' with the actual ID (keep the quotes!)

-- Test insert into shop_customers
INSERT INTO shop_customers (
  shop_id,
  phone_number,
  customer_name,
  total_spent,
  first_source_slug
) VALUES (
  'paste-your-shop-id-here',
  '0551234567',
  'Test Customer',
  10.50,
  'test'
) RETURNING id, shop_id, phone_number, customer_name;

-- Step 3: If insert worked, verify it was created
SELECT * FROM shop_customers 
WHERE phone_number = '0551234567'
ORDER BY created_at DESC LIMIT 1;

-- Step 4: Check if RLS policies exist
SELECT schemaname, tablename, policyname, permissive, roles, qual, with_check
FROM pg_policies 
WHERE tablename = 'shop_customers'
ORDER BY policyname;
