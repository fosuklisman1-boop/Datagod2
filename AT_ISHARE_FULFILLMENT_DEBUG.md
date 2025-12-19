# AT-iShare Fulfillment Debugging Guide

## Issue
AT-iShare orders are not triggering fulfillment and are not being logged.

## Root Causes Identified & Fixed

### 1. ✅ FIXED: Admin orders list was including AT-iShare orders
**Status**: FIXED in commit `53c0041`
- The `/api/admin/orders/pending` endpoint was not filtering out AT-iShare orders
- Added `.neq("network", "AT-iShare")` to both bulk and shop order queries

### 2. ✅ IMPROVED: Enhanced logging for fulfillment process
**Status**: IMPROVED in commit `e8f9c43`
- Added comprehensive logging with `[FULFILLMENT]` prefix in purchase route
- Added detailed logging with `[CODECRAFT-FULFILL]` and `[CODECRAFT-LOG]` prefixes in AT-iShare service
- Now logs network validation, API calls, responses, and database updates

### 3. ✅ IMPROVED: Case-insensitive network matching
**Status**: IMPROVED in commit `e8f9c43`
- Changed from exact string match to case-insensitive comparison
- Added support for multiple network name variations: "AT-iShare", "AT - iShare", "AT-ishare", "at-ishare"

## How to Diagnose Fulfillment Issues

### Step 1: Check Frontend Console
1. Open browser Developer Tools (F12)
2. Go to Console tab
3. Look for messages with `[FULFILLMENT]` prefix

**Expected logs when placing AT-iShare order:**
```
[FULFILLMENT] Network received: "AT-iShare" | Normalized: "AT-iShare" | Should fulfill: true | Order: [ORDER_ID]
[FULFILLMENT] Starting fulfillment trigger for AT-iShare order [ORDER_ID] to [PHONE]
[FULFILLMENT] Order details - Network: AT-iShare, Size: [SIZE]GB, Phone: [PHONE], OrderID: [ORDER_ID]
[FULFILLMENT] Calling atishareService.fulfillOrder with network: AT
```

### Step 2: Check Backend Logs
1. Go to Vercel/Deployment logs
2. Search for `[FULFILLMENT]` or `[CODECRAFT-FULFILL]` logs
3. Check for errors like:
   - Network validation failures
   - Missing environment variables
   - API connection issues

**Expected backend logs:**
```
[FULFILLMENT] Network received: "AT-iShare" | Normalized: "AT-iShare" | Should fulfill: true | Order: [ORDER_ID]
[FULFILLMENT] Starting fulfillment trigger for AT-iShare order [ORDER_ID] to [PHONE]
[CODECRAFT-FULFILL] Starting fulfillment request
[CODECRAFT-FULFILL] Order ID: [ORDER_ID]
[CODECRAFT-FULFILL] Phone Number: [PHONE]
[CODECRAFT-FULFILL] Size: [SIZE]GB
[CODECRAFT-FULFILL] Network: AT
[CODECRAFT-FULFILL] Calling Code Craft API...
[CODECRAFT-FULFILL] API URL: https://api.codecraftnetwork.com/api/initiate.php
[CODECRAFT-FULFILL] Request payload: ...
[CODECRAFT-FULFILL] API Response received
[CODECRAFT-FULFILL] HTTP Status: [STATUS]
[CODECRAFT-FULFILL] Response Data: {...}
[CODECRAFT-LOG] Successfully logged fulfillment status to database
[CODECRAFT-LOG] Successfully updated order fulfillment_status in database
```

### Step 3: Check Database

#### Check if order was created:
```sql
SELECT id, network, phone_number, size, price, status, fulfillment_status, created_at
FROM orders
WHERE network = 'AT-iShare'
ORDER BY created_at DESC
LIMIT 10;
```

**Expected results:**
- Orders should exist in `orders` table
- `network` column should be "AT-iShare"
- `fulfillment_status` should be "processing" or "success" (not null or "pending")

#### Check fulfillment logs:
```sql
SELECT order_id, status, api_response, error_message, created_at, updated_at
FROM fulfillment_logs
WHERE order_id = '[YOUR_ORDER_ID]';
```

**Expected results:**
- Entry should exist in `fulfillment_logs` table
- `status` should be "processing" (initial) or "success" (completed)
- `error_message` should be null for successful submissions
- `api_response` should contain Code Craft API response data

### Step 4: Common Issues & Solutions

#### Issue: No fulfillment logs at all
**Possible causes:**
1. Order network is not "AT-iShare" (check spelling/case)
2. Fulfillment trigger is not running (check if statement)
3. `fulfillment_logs` table doesn't exist

**Solutions:**
1. Verify network name in database matches exactly
2. Check frontend and backend logs for network comparison
3. Run migration: `migrations/add_fulfillment_logs_table.sql`

#### Issue: Fulfillment logs exist but show "failed" status
**Possible causes:**
1. Code Craft API credentials invalid (`CODECRAFT_API_KEY`)
2. Code Craft API URL incorrect (`CODECRAFT_API_URL`)
3. Phone number format invalid for Code Craft API
4. Size/GB format issue

**Solutions:**
1. Verify `CODECRAFT_API_KEY` in environment variables
2. Verify `CODECRAFT_API_URL` is correct (should be `https://api.codecraftnetwork.com/api`)
3. Check `error_message` in `fulfillment_logs` table for specific API error
4. Review Code Craft API documentation for phone number format

#### Issue: No logs at all (not even "Network received" log)
**Possible causes:**
1. Order creation failed before fulfillment check
2. Network parameter not being passed correctly
3. JavaScript error in purchase flow

**Solutions:**
1. Check if order exists in database at all
2. Check frontend console for JavaScript errors
3. Verify network parameter is being sent in API request

## Environment Variables Required

Make sure these are set in your Vercel environment:

```
CODECRAFT_API_KEY=your_api_key
CODECRAFT_API_URL=https://api.codecraftnetwork.com/api
```

## Testing Fulfillment Locally

1. Create an AT-iShare order through the UI
2. Check browser console for `[FULFILLMENT]` logs
3. Check server logs (if running locally)
4. Query database:
   - `orders` table for new order
   - `fulfillment_logs` table for fulfillment attempt

## Next Steps if Issues Persist

1. Check Code Craft API response status and error message
2. Verify phone number format (should be valid Ghana phone number)
3. Verify API credentials are correct
4. Check if Code Craft API server is up and accessible
5. Review `fulfillment_logs` error_message for specific Code Craft error codes

## Log Prefixes Reference

| Prefix | Location | Purpose |
|--------|----------|---------|
| `[FULFILLMENT]` | `app/api/orders/purchase/route.ts` | Purchase order fulfillment trigger |
| `[CODECRAFT-FULFILL]` | `lib/at-ishare-service.ts` (fulfillOrder) | Code Craft API call details |
| `[CODECRAFT-LOG]` | `lib/at-ishare-service.ts` (logFulfillment) | Database logging operations |
| `[CODECRAFT]` | `lib/at-ishare-service.ts` (other methods) | Verification and retry logic |

---

**Last Updated**: 2025-12-19
**Commits**: `53c0041` (filter AT-iShare), `e8f9c43` (logging)
