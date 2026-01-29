# Shop Orders Failed Status - Root Cause Analysis & Fix

**Date:** 2026-01-29  
**Issue:** Shop orders being incorrectly marked as "failed"  
**Status:** ✅ FIXED

## Root Cause

Shop orders were being marked as **failed** due to a **payment amount mismatch** in the Paystack webhook verification logic.

### The Problem Flow

1. **Order Creation** (`app/api/shop/orders/create/route.ts`)
   - Validates prices server-side ✓
   - Stores `total_price` correctly in `shop_orders` table ✓

2. **Payment Success** (Paystack webhook: `app/api/webhooks/paystack/route.ts`)
   - Webhook receives payment confirmation from Paystack
   - Attempts to **re-verify** the price by looking up package tables
   - **For sub-agents**: Looks up `sub_agent_shop_packages` table
   - **Problem**: Different table structure causes price calculation mismatch
   - Result: `paidAmount !== expectedAmount` → Order marked as FAILED ❌

### Technical Details

**Original Webhook Logic (BROKEN):**
```typescript
// Tried to re-calculate price from package tables
if (shopData?.parent_shop_id) {
  // Lookup sub_agent_shop_packages
  verifiedTotalPrice = parent_price + sub_agent_profit_margin
  // ❌ This often didn't match the order's total_price
}
```

**Why it Failed:**
- `shop_package_id` can reference different tables for sub-agents
- Different column names: `parent_price` vs `base_price`
- Different pricing structures between tables
- Re-calculation didn't match the original validated price

## The Fix

**Simplified Approach:**
Instead of re-verifying prices in the webhook, **trust the `total_price` already stored in `shop_orders`** table.

**New Webhook Logic:**
```typescript
// Simply use the pre-validated total_price from the order
const { data: shopOrder } = await supabase
  .from("shop_orders")
  .select("id, shop_id, total_price")
  .eq("id", paymentData.order_id)
  .single();

expectedAmountGHS = shopOrder.total_price;
// ✅ This matches what the customer actually paid
```

### Why This Works

1. **Single Source of Truth**: Order creation already validates prices server-side
2. **No Re-calculation**: Avoids table structure mismatches
3. **Consistency**: Same price used throughout the payment flow
4. **Security Maintained**: Order creation still does comprehensive validation

## Files Modified

- **`app/api/webhooks/paystack/route.ts`** (lines 166-193)
  - Removed complex package lookup logic (73 lines)
  - Added simple total_price trust logic (28 lines)
  - Net: -45 lines of error-prone code

## Testing Recommendations

1. **Sub-agent shop orders** - These were the primary failures
2. **Regular shop orders** - Ensure still working
3. **Monitor webhook logs** for `[WEBHOOK] ❌ PAYMENT AMOUNT MISMATCH` errors
4. **Check admin orders dashboard** for failed orders

## Impact

- **Before**: Sub-agent shop orders frequently marked as failed
- **After**: Orders succeed when payment amount matches order total
- **Risk**: Low - Simply trusting pre-validated data instead of re-calculating

## Deployment

✅ **Committed**: `3b0c040`  
✅ **Pushed**: `origin/main`  
📅 **Deployed**: Auto-deploy via Vercel (if configured)

## Monitoring

Check for these log messages:
- ✅ `[WEBHOOK] ✓ Payment amount verified` - Success
- ❌ `[WEBHOOK] ❌ PAYMENT AMOUNT MISMATCH` - Should no longer occur for valid orders
- ℹ️ `[WEBHOOK] Price debug info: { source: "shop_orders_total_price" }` - New behavior

---

**Fix Author:** Antigravity AI  
**Commit:** `fix(webhook): prevent shop orders from failing due to price verification mismatches`
