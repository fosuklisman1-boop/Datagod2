# AFA Orders Database Setup

## Issue
The AFA submission API is returning 404 because the `afa_orders` table doesn't exist in the Supabase database.

## Solution

You need to run the migration SQL to create the `afa_orders` table in your Supabase database.

### Steps to Run the Migration:

1. **Go to Supabase Dashboard**
   - Navigate to https://app.supabase.com
   - Select your project

2. **Open SQL Editor**
   - Go to the **SQL Editor** section
   - Click **New Query**

3. **Copy and Execute the Migration**
   - Open the file: `migrations/create_afa_orders_table.sql`
   - Copy the entire SQL content
   - Paste it into the Supabase SQL Editor
   - Click **Run**

4. **Verify the Table**
   - Go to **Table Editor**
   - You should now see the `afa_orders` table with the following columns:
     - `id` (UUID)
     - `user_id` (UUID)
     - `order_code` (VARCHAR)
     - `transaction_code` (VARCHAR)
     - `full_name` (VARCHAR)
     - `phone_number` (VARCHAR)
     - `gh_card_number` (VARCHAR)
     - `location` (VARCHAR)
     - `region` (VARCHAR)
     - `occupation` (VARCHAR)
     - `amount` (DECIMAL)
     - `status` (VARCHAR)
     - `created_at` (TIMESTAMP)
     - `updated_at` (TIMESTAMP)

5. **Test the API**
   - After creating the table, try submitting an AFA registration again
   - The API should now work and return a 200 success response

## What the Migration Does

1. **Creates `afa_orders` table** with all required fields
2. **Creates indexes** for faster queries on user_id, order_code, transaction_code, status, and created_at
3. **Enables Row Level Security (RLS)** to ensure data privacy
4. **Creates RLS policies**:
   - Users can read their own AFA orders
   - Admins can read all AFA orders
   - Users can create their own orders
   - Admins can update order status

## Database Schema

```
afa_orders
├── id (UUID, Primary Key)
├── user_id (UUID, Foreign Key to auth.users)
├── order_code (VARCHAR, Unique)
├── transaction_code (VARCHAR, Unique)
├── full_name (VARCHAR)
├── phone_number (VARCHAR)
├── gh_card_number (VARCHAR)
├── location (VARCHAR)
├── region (VARCHAR)
├── occupation (VARCHAR)
├── amount (DECIMAL)
├── status (VARCHAR - pending, processing, completed, cancelled)
├── created_at (TIMESTAMP)
└── updated_at (TIMESTAMP)
```

## Notes

- RLS is enabled to protect user data
- Only admins and the order creator can see the order details
- Admins can only update orders (change status)
- All fields are properly indexed for performance
