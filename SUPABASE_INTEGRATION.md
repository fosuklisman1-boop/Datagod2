# DATAGOD + Supabase Integration

This document explains how to use Supabase services in your DATAGOD application.

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Up Environment Variables
Create `.env.local` in your project root:
```env
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 3. Create Database Schema
Follow the SQL queries in `SUPABASE_SETUP.md` to create tables and policies.

### 4. Start the Dev Server
```bash
npm run dev
```

## Using Supabase in Your Components

### Authentication Hook

```tsx
import { useAuth } from "@/hooks/use-auth"

export function MyComponent() {
  const { user, loading, isAuthenticated, login, logout } = useAuth()

  if (loading) return <div>Loading...</div>

  if (!isAuthenticated) {
    return <button onClick={() => login(email, password)}>Login</button>
  }

  return (
    <div>
      <p>Welcome, {user?.email}</p>
      <button onClick={logout}>Logout</button>
    </div>
  )
}
```

### Database Services

```tsx
import { packageService, orderService } from "@/lib/database"

// Get all data packages
const packages = await packageService.getPackages()

// Get packages by network
const mtmPackages = await packageService.getPackagesByNetwork("MTN")

// Create an order
const order = await orderService.createOrder({
  user_id: "user-id",
  package_id: "package-id",
  phone_number: "233123456789",
  status: "pending",
})

// Get user's orders
const userOrders = await orderService.getOrders("user-id")
```

### Wallet Operations

```tsx
import { walletService } from "@/lib/database"

// Get user's wallet
const wallet = await walletService.getWallet("user-id")

// Update wallet balance
await walletService.updateBalance("user-id", 50.00)

// Create wallet for new user
const newWallet = await walletService.createWallet({
  user_id: "user-id",
  balance: 0,
})
```

### Real-time Subscriptions

```tsx
import { supabase } from "@/lib/supabase"

useEffect(() => {
  // Subscribe to changes in orders table
  const subscription = supabase
    .from("orders")
    .on("*", (payload) => {
      console.log("Order change:", payload)
    })
    .subscribe()

  return () => {
    subscription.unsubscribe()
  }
}, [])
```

## File Structure

```
lib/
├── supabase.ts          # Supabase client configuration
├── database.ts          # Database service functions
└── auth.ts              # Authentication helpers

hooks/
├── use-auth.ts          # Auth hook for components
└── use-mobile.ts        # Existing mobile hook

middleware.ts            # Route protection middleware
```

## Database Schema Overview

### users
- User profiles and information
- Connected to Supabase Auth via email

### packages
- Data packages available for purchase
- Networks: AT - iShare, TELECEL, MTN, AT - BigTime

### orders
- User data package orders
- Tracks status, phone number, and codes

### wallets
- User wallet balances
- Tracks spending and credits

### transactions
- Financial transactions history
- Credit, debit, and refund types

### afa_orders
- MTN AFA registration orders
- Tracks registration status

### complaints
- User complaints and issues
- Tracks status and resolution

## Common Tasks

### Login User
```tsx
const { login } = useAuth()

await login("user@example.com", "password123")
```

### Create Order
```tsx
const order = await orderService.createOrder({
  user_id: userId,
  package_id: packageId,
  network: "MTN",
  size: "1GB",
  price: 4.5,
  phone_number: "233123456789",
  status: "pending",
})
```

### Update Wallet
```tsx
await walletService.updateBalance(userId, 100.00)
```

### Get User Transactions
```tsx
const transactions = await transactionService.getTransactions(userId)
```

## Error Handling

```tsx
import { useAuth } from "@/hooks/use-auth"
import { toast } from "sonner"

const { login, error } = useAuth()

const handleLogin = async () => {
  try {
    await login(email, password)
    toast.success("Logged in successfully")
  } catch (err) {
    toast.error(error?.message || "Login failed")
  }
}
```

## Security

- Row Level Security (RLS) policies protect data
- Users can only access their own data
- Authentication required for dashboard routes
- Middleware handles route protection

## Troubleshooting

### "User not authenticated"
- Make sure user is logged in
- Check that JWT token is valid
- Verify RLS policies are correct

### "Table not found"
- Ensure all tables are created in Supabase
- Check table names match SQL queries

### "CORS Error"
- Verify NEXT_PUBLIC_SUPABASE_URL is correct
- Check Supabase project settings for allowed origins

### Environment Variables Not Loading
- Restart dev server after adding .env.local
- Variables must start with NEXT_PUBLIC_ to be accessible in browser

## Resources

- [Supabase Docs](https://supabase.com/docs)
- [Next.js Supabase Integration](https://supabase.com/docs/guides/getting-started/quickstarts/nextjs)
- [Authentication Helpers](https://supabase.com/docs/guides/auth/auth-helpers/nextjs)

## Next Steps

1. Replace login/signup pages with Supabase auth
2. Migrate sample data to database
3. Connect form submissions to database
4. Implement real-time features with Supabase subscriptions
5. Set up automated migrations for database schema
