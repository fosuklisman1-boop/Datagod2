# Manual Fulfillment Feature Implementation

## Overview
Implemented a manual fulfillment trigger button on the Order Payment Status admin page that allows admins to force-trigger MTN order fulfillment when auto-fulfillment is enabled.

## Implementation Details

### Backend Endpoint
**File**: `app/api/admin/fulfillment/manual-fulfill/route.ts`
**Method**: POST
**URL**: `/api/admin/fulfillment/manual-fulfill`

#### Request Body
```json
{
  "shop_order_id": "uuid",
  "order_type": "shop" | "bulk"  // optional, defaults to "shop"
}
```

#### Features
- Verifies admin access via token
- Checks fulfillment logs to prevent duplicates
- Checks MTN fulfillment tracking table to prevent duplicate MTN API calls
- Supports both `shop_orders` and `orders` (bulk) tables
- Handles different field names:
  - Shop orders: `order_status`, `customer_phone`
  - Bulk orders: `status`, `phone_number`
- Validates blacklist status
- Creates MTN order via `createMTNOrder()`
- Saves tracking record via `saveMTNTracking()`
- Updates order status to "processing"
- Creates fulfillment log entry
- Sends SMS confirmation to customer
- Comprehensive logging for debugging

#### Error Checks (in order)
1. ✅ Admin access verification
2. ✅ Order exists in correct table
3. ✅ Order not already completed/failed
4. ✅ No existing fulfillment logs (pending/completed)
5. ✅ No existing MTN tracking records (pending/processing/completed)
6. ✅ Only MTN network orders
7. ✅ Order not in blacklist queue
8. ✅ Phone number not blacklisted

### Frontend Component
**File**: `app/admin/order-payment-status/page.tsx`

#### New Features
- Loads auto-fulfillment setting on page load
- Displays "Fulfill" button for eligible orders
- Shows network type for non-MTN orders (e.g., "Telecel (no auto-fulfill)")
- Shows "Auto-fulfill disabled" when setting is off
- Comprehensive logging for debugging

#### Button Visibility Conditions
Button appears ONLY when ALL of these are true:
- ✅ Auto-fulfillment is enabled
- ✅ Order status = "pending"
- ✅ Payment status = "completed"
- ✅ Order type = "shop" OR "bulk"
- ✅ Network = "MTN" (only MTN fulfillment supported)

#### Handler: `handleManualFulfill(orderId, orderType)`
- Passes order ID and type to backend
- Sends auth token in header
- Shows loading state during fulfillment
- Updates order status to "processing" on success
- Shows error toast on failure
- Logs request/response for debugging

### API Settings Integration
**File**: `app/api/admin/settings/mtn-auto-fulfillment/route.ts`

- GET endpoint returns `{ enabled: boolean, updated_at: timestamp }`
- Frontend loads setting on page load with auth token
- Button respects this setting

## Testing Checklist

### Prerequisites
- [ ] Deployed to production (run `git push` to trigger Vercel deployment)
- [ ] Auto-fulfillment setting enabled in admin settings

### Frontend Testing
- [ ] Navigate to Order Payment Status page
- [ ] Verify auto-fulfillment setting loads (check console: `[PAYMENT-STATUS] Auto-fulfillment setting response:`)
- [ ] Filter/search for MTN orders with:
  - Order status = "pending"
  - Payment status = "completed"
- [ ] Verify "Fulfill" button appears for MTN orders only
- [ ] Verify button hidden for non-MTN orders (shows network type instead)
- [ ] Verify button hidden when auto-fulfillment is disabled

### Fulfillment Testing
- [ ] Click "Fulfill" button on MTN order
- [ ] Check console logs:
  - `[PAYMENT-STATUS] Triggering manual fulfillment:`
  - `[PAYMENT-STATUS] Sending payload:`
  - `[PAYMENT-STATUS] Response status: 200`
- [ ] Verify order status changes to "processing"
- [ ] Check backend logs for:
  - `[MANUAL-FULFILL] Admin triggering fulfillment for (shop/bulk):`
  - `[MANUAL-FULFILL] Querying table: shop_orders/orders`
  - `[MANUAL-FULFILL] Query result - Error: none, Data found: true`
  - `[MANUAL-FULFILL] Order details - Network: MTN, Status: pending`

### Error Cases
- [ ] Test with blacklisted order - should show "Order is blacklisted"
- [ ] Test with non-MTN order - button should not appear
- [ ] Test with non-pending order - button should not appear
- [ ] Test with uncompleted payment - button should not appear
- [ ] Test double-click - should show "Order already has a pending fulfillment"

## Deployment Notes

### What Was Changed
- Added new endpoint: `app/api/admin/fulfillment/manual-fulfill/route.ts`
- Updated: `app/admin/order-payment-status/page.tsx`
  - Added auto-fulfillment setting loader
  - Added manual fulfillment handler
  - Added button with visibility conditions
  - Added network type indicator for non-MTN orders
  - Added comprehensive logging

### Required on Production
- Endpoint must be deployed to enable the feature
- If you see 404 error, deployment is not complete
- Check Vercel dashboard for build errors

### RLS Considerations
- Endpoint uses `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS
- No additional RLS policies needed
- Service role can query both `shop_orders` and `orders` tables

## Debugging

### Common Issues

**Issue**: Button not appearing
- **Check**: Auto-fulfillment setting enabled?
- **Check**: Order has pending status?
- **Check**: Order payment status is completed?
- **Check**: Order network is MTN?

**Issue**: 404 error on fulfillment click
- **Check**: Has deployment completed on Vercel?
- **Check**: Build logs show no errors?

**Issue**: "Order not found" error
- **Check**: Order ID format correct?
- **Check**: Order exists in the correct table (shop_orders for type="shop", orders for type="bulk")?
- **Check**: Order network is MTN?

**Issue**: "Order already has a pending fulfillment"
- **Check**: Fulfillment logs have previous attempt
- **Check**: Click button again after previous attempt completes

### Logging
Enable detailed logging via browser console:
```javascript
// All manual fulfillment logs
console.log("[PAYMENT-STATUS]")
```

Backend logs available in production:
- Vercel Function Logs
- Check for `[MANUAL-FULFILL]` prefix

## Related Documentation
- [Payment Flow Documentation](./features/shop/SHOP_ORDER_PAYMENT_FLOW.md)
- [MTN Integration](./features/mtn-integration/)
- [Blacklist System](./BLACKLIST_PROTECTION_SYSTEM.md)
