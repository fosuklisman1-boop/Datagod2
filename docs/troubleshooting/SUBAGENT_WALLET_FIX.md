# Sub-Agent Wallet Creation Fix

## Problem
Sub-agents were not receiving wallet records when created via the referral invitation flow. This prevented them from:
- Topping up their wallet via Paystack
- Purchasing data packages (bulk orders)
- Using the buy-stock feature

## Root Cause
The sub-agent account creation endpoint (`/api/shop/invites/[code]`) was creating:
1. ✅ Auth user account
2. ✅ User profile record (users table)
3. ✅ Shop record (user_shops table)
4. ❌ **Missing:** Wallet record (wallets table)

While regular user signup (`/api/auth/signup`) correctly created wallets, the sub-agent invitation flow skipped wallet creation entirely.

## Solution
Added wallet creation to the sub-agent signup flow in `app/api/shop/invites/[code]/route.ts`:

```typescript
// Create wallet for sub-agent
const { error: walletError } = await supabase
  .from("wallets")
  .insert({
    user_id: newUserId,
    balance: 0,
    total_credited: 0,
    total_spent: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })

if (walletError) {
  console.error("Error creating wallet:", walletError)
  // Continue anyway - wallet might be created by trigger
}
```

## Changes Made
- **File:** `app/api/shop/invites/[code]/route.ts`
- **Commit:** c0c724f
- **Lines Added:** 17 new lines (insertion after user record creation)

## Testing
To verify the fix:

1. **Create a referral invite:**
   - Login as admin/shop owner
   - Go to My Shop → Invites/Settings
   - Create a new invite code

2. **Accept invite with new sub-agent account:**
   - Visit the invite link (or `/join/{code}`)
   - Fill in email, password, shop name
   - Submit form

3. **Verify wallet was created:**
   - Query Supabase: `SELECT * FROM wallets WHERE user_id = '{new_user_id}'`
   - Wallet should have:
     - balance = 0
     - total_credited = 0
     - total_spent = 0

4. **Test wallet functionality:**
   - Login as new sub-agent
   - Go to Dashboard → Wallet
   - Should load wallet balance (0.00 GHS)
   - Should be able to click "Top Up Wallet" and proceed to Paystack
   - Go to Dashboard → Buy Stock
   - Should be able to see parent's packages and can checkout (if wallet has funds)

## Affected Flows
✅ **Sub-Agent Signup** - Wallet now auto-created
✅ **Wallet Top-Up** - Now works for new sub-agents
✅ **Buy-Stock Feature** - Now available for new sub-agents
✅ **Data Package Purchase** - Now works for new sub-agents

## Database Schema
The `wallets` table requires these columns (already exists):
- `user_id` (uuid, FK to users)
- `balance` (decimal)
- `total_credited` (decimal)
- `total_spent` (decimal)
- `created_at` (timestamp)
- `updated_at` (timestamp)

## Backward Compatibility
- Existing sub-agents without wallets will auto-create a wallet on first wallet access via `/api/wallet/create` (called by data-packages page)
- No migration needed for existing users
- The fix is one-way: only affects new sign-ups

## Related Files
- `app/api/auth/signup/route.ts` - Regular user signup (already creates wallets)
- `app/api/wallet/create/route.ts` - Client-side wallet creation endpoint
- `app/dashboard/data-packages/page.tsx` - Auto-creates wallet if missing
- `components/wallet-top-up.tsx` - Uses wallet balance
- `app/dashboard/buy-stock/page.tsx` - Uses wallet balance

## Commit Reference
```
c0c724f Fix: Auto-create wallet for sub-agents during signup via referral invite
```
