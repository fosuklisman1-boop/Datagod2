# AT-iShare Wallet Orders Not Triggering Fulfillment - Debugging Steps

## Summary of Issue
Wallet/data package orders for AT-iShare are not triggering fulfillment.

## Fixes Applied So Far
1. ✅ Shop orders fulfillment - Fixed in `/api/payments/verify`
2. ✅ Wallet orders have fulfillment code - Already in `/api/orders/purchase`
3. ✅ Enhanced logging added - To trace the issue

## What We Know
- Wallet orders use `/api/orders/purchase` endpoint
- Fulfillment code IS present in that endpoint
- Fulfillment checks if network is "AT-iShare" (case-insensitive)
- If network matches, calls `atishareService.fulfillOrder()`

## Possible Root Causes

### Cause 1: AT-iShare Packages Don't Exist in Database
**Symptom**: No AT-iShare options appear in `/dashboard/data-packages`

**Check**: Query the packages table
```sql
SELECT DISTINCT network FROM packages ORDER BY network;
```

**Expected Result**: Should see "AT-iShare" in the list

**If Missing**: Need to create AT-iShare packages via admin panel or database migration

### Cause 2: Network Name Mismatch
**Symptom**: AT-iShare packages exist but fulfillment not triggered

**Check**: Look at Vercel logs for this log when making wallet purchase:
```
[PURCHASE] Network: "<ACTUAL_VALUE>"
```

**Common Issues**:
- Stored as "iShare" instead of "AT-iShare"
- Stored as "AT-ishare" (lowercase)
- Stored as "AT - iShare" (with spaces)
- Stored as "ATISHARE" (no hyphen, all caps)

**Solution**: The code already handles multiple variations:
```typescript
const fulfillableNetworks = ["AT-iShare", "AT - iShare", "AT-ishare", "at-ishare"]
```

But if it's "iShare" or "ATISHARE", we need to add those to the list.

### Cause 3: Environment Variables Not Set
**Check**: Verify in Vercel dashboard
```
CODECRAFT_API_KEY - Should be set
CODECRAFT_API_URL - Should be set to https://api.codecraftnetwork.com/api
```

**If Missing**: Set them in Vercel environment variables

## How to Verify Fulfillment is Triggered

### Step 1: Check Database for Packages
```sql
-- See all packages
SELECT id, network, size, price FROM packages 
ORDER BY network, size;

-- See if AT-iShare packages exist
SELECT * FROM packages 
WHERE network LIKE '%iShare%' OR network LIKE '%AT%'
ORDER BY network;
```

### Step 2: Make a Test Purchase
1. Go to `/dashboard/data-packages`
2. If AT-iShare appears:
   - Click "Buy" on an AT-iShare package
   - Enter phone number
   - Complete purchase
3. Check Vercel logs immediately for:
   - `[PURCHASE] ========== NEW ORDER REQUEST ==========` 
   - `[PURCHASE] Network: "AT-iShare"`
   - `[FULFILLMENT] Network received: "AT-iShare"`
   - `[FULFILLMENT] Should fulfill: true`
   - `[CODECRAFT-FULFILL]` logs

### Step 3: Check Database After Purchase
```sql
-- Check if order was created
SELECT id, network, fulfillment_status 
FROM orders 
WHERE network LIKE '%iShare%'
ORDER BY created_at DESC
LIMIT 5;

-- Check fulfillment logs
SELECT order_id, status, error_message 
FROM fulfillment_logs 
WHERE order_id IN (
  SELECT id FROM orders 
  WHERE network LIKE '%iShare%'
  ORDER BY created_at DESC
  LIMIT 5
);
```

## Next Steps

1. **If AT-iShare packages don't exist**: Create them via admin panel or database
2. **If network name is different**: Update the `fulfillableNetworks` list in `/api/orders/purchase/route.ts`
3. **If environment variables missing**: Set them in Vercel
4. **If all looks good but still not working**: Check Vercel logs for the `[PURCHASE]` logs to see actual network value

## Commands to Check Logs

### Vercel CLI (if installed locally)
```bash
vercel logs --follow
```

### Vercel Dashboard
1. Go to vercel.com
2. Select your project
3. Click "Deployments"
4. Click latest deployment
5. Look for "Logs" or "Monitoring" tab

## Files to Reference
- `/app/api/orders/purchase/route.ts` - Where wallet order fulfillment happens
- `/app/dashboard/data-packages/page.tsx` - Where users buy wallet packages
- `/lib/at-ishare-service.ts` - The fulfillment service

---

**Next Action**: Check if AT-iShare packages exist in the database!
