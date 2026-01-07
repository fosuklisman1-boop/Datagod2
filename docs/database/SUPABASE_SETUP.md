# Supabase Setup Guide for DATAGOD

This guide will help you set up Supabase for the DATAGOD application.

## Prerequisites

- A Supabase account (sign up at [supabase.com](https://supabase.com))
- Node.js 18+ installed locally

## Step 1: Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in to your account
2. Click "New Project" and fill in the details:
   - **Name**: datagod-app
   - **Database Password**: Create a strong password and save it
   - **Region**: Choose the region closest to your users
3. Click "Create new project" and wait for it to complete (usually 2-3 minutes)

## Step 2: Get Your API Keys

1. Once the project is created, go to **Settings → API** in the Supabase dashboard
2. Copy the following values from the "Project API keys" section:
   - **URL**: Your project URL (looks like `https://xxxxxxxxxxxx.supabase.co`)
   - **Anon Key**: Your anonymous public key
3. Keep these safe - you'll need them in the next step

## Step 3: Configure Environment Variables

1. Create a `.env.local` file in the project root directory:

```bash
cp .env.example .env.local
```

2. Open `.env.local` and add your Supabase credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## Step 4: Create Database Tables

Run the following SQL queries in your Supabase dashboard SQL Editor:

### Users Table

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  username VARCHAR(255) UNIQUE,
  phone VARCHAR(20),
  phone_number VARCHAR(20),
  role VARCHAR(50) DEFAULT 'user',
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS (Row Level Security)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Create RLS Policy
CREATE POLICY "Users can read their own data" ON users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update their own data" ON users
  FOR UPDATE USING (auth.uid() = id);
```

### Packages Table

```sql
CREATE TABLE packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network VARCHAR(100) NOT NULL,
  size VARCHAR(50) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  description TEXT,
  features JSONB DEFAULT '[]'::jsonb,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE packages ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read packages
CREATE POLICY "Anyone can read packages" ON packages
  FOR SELECT USING (active = true);
```

### Orders Table

```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES packages(id),
  network VARCHAR(100),
  size VARCHAR(50),
  price DECIMAL(10, 2),
  status VARCHAR(50) DEFAULT 'pending',
  phone_number VARCHAR(20),
  order_code VARCHAR(100),
  transaction_code VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Users can read their own orders
CREATE POLICY "Users can read their own orders" ON orders
  FOR SELECT USING (auth.uid() = user_id);

-- Users can create orders
CREATE POLICY "Users can create orders" ON orders
  FOR INSERT WITH CHECK (auth.uid() = user_id);
```

### Wallets Table

```sql
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance DECIMAL(15, 2) DEFAULT 0.00,
  total_credited DECIMAL(15, 2) DEFAULT 0.00,
  total_spent DECIMAL(15, 2) DEFAULT 0.00,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;

-- Users can read their own wallet
CREATE POLICY "Users can read their own wallet" ON wallets
  FOR SELECT USING (auth.uid() = user_id);

-- Users can update their own wallet (restricted)
CREATE POLICY "Users can update their own wallet" ON wallets
  FOR UPDATE USING (auth.uid() = user_id);
```

### Transactions Table

```sql
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- 'credit', 'debit', 'refund'
  source VARCHAR(100), -- 'wallet_topup', 'data_purchase', 'afa_registration', 'refund'
  amount DECIMAL(15, 2) NOT NULL,
  balance_before DECIMAL(15, 2),
  balance_after DECIMAL(15, 2),
  description TEXT,
  reference_id VARCHAR(100),
  status VARCHAR(50) DEFAULT 'completed',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Users can read their own transactions
CREATE POLICY "Users can read their own transactions" ON transactions
  FOR SELECT USING (auth.uid() = user_id);
```

### AFA Orders Table

```sql
CREATE TABLE afa_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_code VARCHAR(100) NOT NULL,
  transaction_code VARCHAR(100) NOT NULL,
  phone_number VARCHAR(20),
  agent_name VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'processing', 'delivered', 'cancelled'
  amount DECIMAL(10, 2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE afa_orders ENABLE ROW LEVEL SECURITY;

-- Users can read their own AFA orders
CREATE POLICY "Users can read their own AFA orders" ON afa_orders
  FOR SELECT USING (auth.uid() = user_id);
```

### Complaints Table

```sql
CREATE TABLE complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(100),
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'in-progress', 'resolved', 'rejected'
  priority VARCHAR(50) DEFAULT 'medium',
  order_id UUID REFERENCES orders(id),
  resolution_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;

-- Users can read their own complaints
CREATE POLICY "Users can read their own complaints" ON complaints
  FOR SELECT USING (auth.uid() = user_id);

-- Users can create complaints
CREATE POLICY "Users can create complaints" ON complaints
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Admins can read all complaints
CREATE POLICY "Admins can read all complaints" ON complaints
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

-- Admins can update all complaints
CREATE POLICY "Admins can update all complaints" ON complaints
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );
```

## Step 5: Create Storage Buckets (Optional)

For storing user avatars or receipt images:

1. Go to **Storage** in the Supabase dashboard
2. Create a new bucket called `avatars`
3. Create another bucket called `receipts`
4. Configure public access as needed

## Step 6: Install Dependencies

```bash
npm install
```

## Step 7: Start Development Server

```bash
npm run dev
```

The app will be available at `http://localhost:3000`

## Step 8: Test the Setup

1. Navigate to the signup page (`/auth/signup`)
2. Create a new account with your email
3. Check your email for the confirmation link (from Supabase)
4. Once verified, you should be able to login
5. Create some data packages in the Supabase dashboard to test

## Useful Supabase Resources

- [Supabase Documentation](https://supabase.com/docs)
- [Supabase JavaScript Client Library](https://supabase.com/docs/reference/javascript/introduction)
- [Next.js Integration Guide](https://supabase.com/docs/guides/getting-started/quickstarts/nextjs)
- [Authentication Helpers](https://supabase.com/docs/guides/auth/auth-helpers/nextjs)

## Troubleshooting

### Missing Environment Variables
- Make sure you have `.env.local` file in the project root
- Verify both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set correctly
- Restart the dev server after adding environment variables

### Database Connection Error
- Check if your Supabase project is active in the dashboard
- Verify API keys are correct
- Ensure the database tables are created

### Authentication Not Working
- Check email confirmation settings in Supabase Auth settings
- Verify the `NEXT_PUBLIC_APP_URL` environment variable matches your app URL
- Check browser console for specific error messages

### RLS Errors
- Make sure Row Level Security policies are properly configured
- Check that you're logged in before accessing protected resources
- Review Supabase logs for detailed error information

## Next Steps

1. Update authentication pages to use `authService` from `lib/auth.ts`
2. Replace hardcoded sample data with actual database queries
3. Implement form handlers to save data to the database
4. Add error handling and loading states
5. Set up CI/CD for database migrations

## Database Functions (Optional)

For more complex operations, you can create database functions:

```sql
-- Update wallet balance function
CREATE OR REPLACE FUNCTION update_wallet_balance(p_user_id UUID, p_amount DECIMAL)
RETURNS DECIMAL AS $$
DECLARE
  new_balance DECIMAL;
BEGIN
  UPDATE wallets
  SET balance = balance + p_amount,
      updated_at = NOW()
  WHERE user_id = p_user_id
  RETURNING balance INTO new_balance;
  
  RETURN new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

## Security Best Practices

1. **Never expose your Service Role Key** in the frontend code
2. **Use Row Level Security (RLS)** for all tables
3. **Enable 2FA** on your Supabase account
4. **Regularly rotate API keys** in production
5. **Validate all user inputs** server-side
6. **Use environment variables** for sensitive data
7. **Monitor Supabase logs** for suspicious activity

---

For more support, visit [Supabase Support](https://supabase.com/support)
