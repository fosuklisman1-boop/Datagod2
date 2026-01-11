# DATAGOD AI Coding Instructions

## Project Overview
DATAGOD is a Next.js 15 e-commerce platform for selling mobile data packages, airtime, and digital services in Ghana. It uses Supabase for authentication/database, Paystack for payments, and integrates with MTN and AT (via CodeCraft) APIs for auto-fulfillment.

## Architecture

### Core Data Flow
1. **Customer** → Shop storefront (`/shop/[slug]`) → Checkout → Paystack payment
2. **Paystack webhook** (`/api/webhooks/paystack/route.ts`) → Payment verification → Auto-fulfillment (MTN/AT) or manual queue
3. **Dashboard** → User manages orders, wallet, complaints | **Admin** → Manages shops, orders, withdrawals

### Key Service Layers
- `lib/supabase.ts` - Two clients: `supabase` (anon key for client) and `supabaseAdmin` (service role for server-side privileged operations)
- `lib/shop-service.ts` - All shop/package/order CRUD operations
- `lib/mtn-fulfillment.ts` - MTN network auto-fulfillment with circuit breaker and rate limiting
- `lib/at-ishare-service.ts` - AT/Telecel fulfillment via CodeCraft API
- `lib/payment-service.ts` - Client-side payment initialization wrapper
- `lib/notification-service.ts` - In-app notifications (stored in Supabase)
- `lib/sms-service.ts` - SMS via Moolre API

### Database Tables (Supabase PostgreSQL)
Core: `users`, `user_shops`, `shop_packages`, `shop_orders`, `orders`, `wallet_payments`, `wallet_transactions`
Fulfillment: `mtn_fulfillment_tracking`, `fulfillment_logs`, `at_ishare_logs`
Features: `complaints`, `notifications`, `admin_settings`, `app_settings`, `shop_settings`

## Development Patterns

### API Routes (Next.js App Router)
All API routes in `app/api/` use the pattern:
```typescript
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(supabaseUrl, serviceRoleKey) // Server-side uses service role

export async function POST(request: NextRequest) {
  // Always validate input, log with [CONTEXT] prefix
  console.log("[PAYMENT-INIT] Request received:", body)
  // Return JSON responses with success/error fields
  return NextResponse.json({ success: true, data })
}
```

### React Components
- UI components in `components/ui/` use shadcn/ui with Radix primitives
- Use `cn()` from `lib/utils.ts` for className merging: `cn("base-class", conditional && "optional-class")`
- Forms use `react-hook-form` with `zod` validation
- Toast notifications via `sonner` (imported as `toast`)

### Authentication & Authorization
- `useAuth()` hook for auth state, `useIsAdmin()` for admin checks
- Admin routes check `users.role === "admin"` or `user.user_metadata.role === "admin"`
- Client auth: `AuthProvider` wraps app, redirects based on auth state
- Protected pages: Use `useAuth()` and redirect if `!user` in `useEffect`

### Hooks Pattern
Custom hooks in `hooks/` follow naming `use-*.ts`:
- `use-auth.ts` - Authentication state and methods
- `use-admin.ts` - Admin role checks with `useIsAdmin()`, `useAdminProtected()`
- `use-app-settings.ts` - Global app configuration
- `use-shop-settings.ts` - Per-shop settings

## Environment Variables
Required:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Client Supabase
- `SUPABASE_SERVICE_ROLE_KEY` - Server-side privileged operations
- `PAYSTACK_SECRET_KEY`, `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` - Payments
- `CODECRAFT_API_URL`, `CODECRAFT_API_KEY` - AT iShare fulfillment
- `MTN_API_KEY`, `MTN_API_BASE_URL` - MTN auto-fulfillment
- `MOOLRE_API_KEY`, `MOOLRE_SENDER_ID` - SMS notifications

## Key Commands
```bash
npm run dev      # Start dev server on port 3000
npm run build    # Production build (ESLint disabled for builds)
npm run lint     # Run ESLint
```

## Code Conventions

### Logging
All services use prefixed logging for traceability:
```typescript
console.log("[CODECRAFT-FULFILL] Starting fulfillment request")
console.log("[PAYMENT-INIT] ✓ Payment record created:", data.id)
console.error("[WEBHOOK] ❌ Failed to process:", error)
```

### Error Handling
- API routes return `{ error: string }` with appropriate HTTP status
- Services throw errors with descriptive messages; callers handle with try/catch
- Use `toast.error()` for user-facing errors, `console.error()` for debugging

### Database Queries
- Always use service role client in API routes for bypassing RLS when needed
- Select only needed columns: `.select("id, user_id, status")` not `.select("*")`
- Use `.single()` when expecting one result, handle `PGRST116` error (not found)

### Phone Number Handling
Ghanaian numbers use `lib/phone-validation.ts` and `lib/mtn-fulfillment.ts`:
- Normalize to format `0XXXXXXXXXX` (10 digits, starts with 0)
- Network detection from prefix: MTN (024,025,053-055,059), Telecel (020,050), AirtelTigo (026,027,056,057)

## File Organization
- `app/dashboard/` - User dashboard pages
- `app/admin/` - Admin panel (protected by role check)
- `app/shop/[slug]/` - Public shop storefronts
- `components/layout/` - Layout components (sidebar, header)
- `components/ui/` - shadcn/ui primitives
- `migrations/` - SQL migration files for Supabase
- `docs/` - Feature documentation (architecture, deployment, features)
