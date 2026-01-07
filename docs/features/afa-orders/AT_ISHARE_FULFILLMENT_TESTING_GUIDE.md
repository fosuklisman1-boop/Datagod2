# AT-iShare Order Fulfillment - Testing Guide

## Pre-Testing Setup

### 1. Environment Variables
Add these to `.env.local`:
```env
# AT-iShare API Configuration
AT_ISHARE_API_URL=https://api-test.atishare.com/v1
AT_ISHARE_API_KEY=your_test_api_key
AT_ISHARE_API_SECRET=your_test_api_secret
```

### 2. Database Migration
Apply the migration to add fulfillment_logs table:
```sql
-- Run in Supabase SQL Editor or via migration tool
-- File: migrations/add_fulfillment_logs_table.sql
```

### 3. Test Data Setup
Create test orders manually or through the purchase flow.

## Test Scenarios

### Scenario 1: Successful Fulfillment
**Objective**: Verify order fulfills successfully on purchase

**Steps**:
1. Navigate to Data Packages page
2. Select ATN-iShare package (e.g., 1GB)
3. Enter valid test phone number (e.g., +233123456789)
4. Complete purchase
5. Check browser console for success message

**Verification**:
```sql
-- Check fulfillment was logged
SELECT * FROM fulfillment_logs 
WHERE network = 'AT-iShare' 
ORDER BY created_at DESC 
LIMIT 1;

-- Expected: status = 'success'
-- Expected: error_message = NULL
-- Expected: fulfilled_at = current timestamp
```

**Expected Outcome**:
- ✅ Order created with `fulfillment_status: 'success'`
- ✅ Fulfillment log created with status 'success'
- ✅ User receives SMS notification
- ✅ Order appears in My Orders page

---

### Scenario 2: Failed Fulfillment (Invalid Phone)
**Objective**: Verify system handles invalid phone gracefully

**Steps**:
1. Try to purchase with invalid phone (e.g., "invalid", "12345")
2. Observe response

**Verification**:
```sql
SELECT * FROM fulfillment_logs 
WHERE phone_number LIKE '%invalid%' 
ORDER BY created_at DESC 
LIMIT 1;

-- Expected: status = 'failed'
-- Expected: error_message contains validation error
-- Expected: attempt_number = 1
-- Expected: retry_after is set
```

**Expected Outcome**:
- ✅ Purchase fails with error message
- ✅ Fulfillment log created with status 'failed'
- ✅ Retry scheduled for later
- ✅ No wallet deducted

---

### Scenario 3: API Error & Retry
**Objective**: Verify retry mechanism works

**Steps**:
1. Temporarily disable AT-iShare API (or use invalid credentials)
2. Purchase AT-iShare package
3. Check fulfillment logs (should show failed)
4. Wait or manually trigger retry
5. Re-enable API
6. Retry order

**Verification**:
```sql
-- Check retry scheduling
SELECT * FROM fulfillment_logs 
WHERE status = 'failed' 
AND attempt_number < max_attempts;

-- Expected: retry_after is in the future
```

**Expected Outcome**:
- ✅ First attempt fails (fulfillment_logs.status = 'failed')
- ✅ Retry scheduled (retry_after set)
- ✅ Admin can manually retry from dashboard
- ✅ On successful retry: status changes to 'success'

---

### Scenario 4: Max Retries Exceeded
**Objective**: Verify system handles max retries

**Steps**:
1. Configure API to always fail for test phone
2. Purchase AT-iShare package
3. Manually retry 3 times
4. Attempt to retry again

**Verification**:
```sql
SELECT * FROM fulfillment_logs 
WHERE phone_number = 'test_phone' 
ORDER BY created_at DESC 
LIMIT 1;

-- Expected: attempt_number = 3 (max)
-- Expected: status = 'failed'
-- Expected: retry_after is NULL or very far future
```

**Expected Outcome**:
- ✅ First 3 attempts fail
- ✅ Retry button disappears after 3 attempts
- ✅ Admin notified (or SMS sent to user)
- ✅ No more retries attempted

---

### Scenario 5: Admin Dashboard
**Objective**: Verify admin dashboard displays and functions correctly

**Steps**:
1. Create 5-10 test AT-iShare orders (mix of success/failed)
2. Navigate to `/dashboard/admin/fulfillment`
3. Test each feature

**Dashboard Tests**:

#### Test 5a: View All Orders
```
Expected:
- All fulfillment orders displayed
- Status, phone, attempts visible
- Correct count shown
```

#### Test 5b: Filter by Status
```
- Click "success" filter → Only successful orders shown
- Click "failed" filter → Only failed orders shown
- Click "all" filter → All orders shown
- Stats update accordingly
```

#### Test 5c: Search by Phone
```
- Enter phone number → Only matching orders shown
- Search updates live
- Partial number matching works
```

#### Test 5d: Refresh Button
```
- Click refresh → Data reloads
- Status changes reflected
- Timestamps updated
```

#### Test 5e: Manual Retry
```
- Find failed order with attempts < 3
- Click "Retry" button → Order retries
- Confirmation message appears
- Dashboard updates after retry
```

#### Test 5f: Export CSV
```
- Click "Export" → CSV downloads
- Open file → Contains all columns
- Format is valid CSV
- Data matches dashboard
```

#### Test 5g: Auto-Refresh
```
- Leave dashboard open for 30+ seconds
- Complete new purchase (different browser/window)
- Wait for auto-refresh (should happen every 30s)
- New order appears on dashboard
```

#### Test 5h: Stats Accuracy
```
- Verify each stat matches actual data:
  - Total = all orders count
  - Success = count where status = 'success'
  - Failed = count where status = 'failed'
  - Processing = count where status = 'processing'
  - Pending = count where status = 'pending'
```

---

### Scenario 6: API Endpoints
**Objective**: Test API endpoints directly

#### Test Fulfillment Status
```bash
curl http://localhost:3000/api/orders/fulfillment?orderId=YOUR_ORDER_ID

# Expected Response:
{
  "success": true,
  "fulfillment": {
    "id": "...",
    "order_id": "...",
    "status": "success",
    "attempt_number": 1,
    "max_attempts": 3,
    ...
  }
}
```

#### Trigger Fulfillment
```bash
curl -X POST http://localhost:3000/api/orders/fulfillment \
  -H "Content-Type: application/json" \
  -d '{
    "action": "trigger",
    "orderId": "YOUR_ORDER_ID"
  }'

# Expected Response (on success):
{
  "success": true,
  "message": "Order fulfilled successfully",
  "fulfillment": {
    "orderId": "...",
    "status": "success",
    "reference": "REF123"
  }
}
```

#### Retry Fulfillment
```bash
curl -X POST http://localhost:3000/api/orders/fulfillment \
  -H "Content-Type: application/json" \
  -d '{
    "action": "retry",
    "orderId": "FAILED_ORDER_ID"
  }'

# Expected Response (on success):
{
  "success": true,
  "message": "Retry successful, order fulfilled",
  ...
}
```

---

### Scenario 7: Database State
**Objective**: Verify database consistency

**Checks**:
```sql
-- 1. Orders table consistency
SELECT 
  COUNT(*) as total_orders,
  COUNT(fulfillment_status) as with_fulfillment_status,
  COUNT(CASE WHEN fulfillment_status IS NULL THEN 1 END) as missing_status
FROM orders WHERE network = 'AT-iShare';

-- 2. Fulfillment logs consistency
SELECT 
  COUNT(*) as total_logs,
  COUNT(DISTINCT order_id) as unique_orders,
  COUNT(CASE WHEN order_id IS NULL THEN 1 END) as orphaned_logs
FROM fulfillment_logs;

-- 3. Check for duplicates
SELECT order_id, COUNT(*) as count
FROM fulfillment_logs
GROUP BY order_id
HAVING COUNT(*) > 1;
-- Expected: No results

-- 4. Status enum values
SELECT DISTINCT fulfillment_status FROM orders WHERE network = 'AT-iShare';
-- Expected: pending, processing, success, failed, NULL

SELECT DISTINCT status FROM fulfillment_logs;
-- Expected: pending, processing, success, failed
```

---

## Performance Testing

### Load Test
```bash
# Simulate 10 simultaneous orders
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/orders/purchase \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_TOKEN" \
    -d '{
      "packageId": "pkg-123",
      "network": "AT-iShare",
      "size": "1GB",
      "price": 10,
      "phoneNumber": "+233123456789"
    }' &
done
wait
```

**Expected**:
- All orders complete successfully
- No database locks
- Response times consistent (<500ms)

---

## Logging Verification

**Look for logs with these patterns**:
```
[AT-ISHARE] Fulfilling order
[AT-ISHARE] API Response status: 200
[AT-ISHARE] Calling API with reference
[FULFILLMENT] Triggering fulfillment
[FULFILLMENT] Triggering fulfillment for AT-iShare order
```

**Enable debug logging**:
Add to `.env.local`:
```env
DEBUG=at-ishare:*
LOG_LEVEL=debug
```

---

## Troubleshooting

### Issue: Orders not fulfilling
1. Check env variables are set
2. Check fulfillment_logs table exists
3. Look for error in server logs
4. Verify order is AT-iShare network
5. Check AT-iShare API is accessible

### Issue: Dashboard shows no orders
1. Verify fulfillment_logs table has data
2. Check user has admin access
3. Try refreshing page
4. Check browser console for errors
5. Verify filters aren't too restrictive

### Issue: Retries not working
1. Check retry_after timestamp
2. Verify background job is running (if using scheduled retries)
3. Check attempt_number < max_attempts
4. Look at error_message for details

---

## Success Criteria

✅ All tests pass if:
- Orders fulfill automatically on purchase
- Fulfillment status tracked accurately
- Admin dashboard displays all data
- Manual retry works and increments attempts
- Max retries prevents infinite loops
- CSV export works correctly
- Database stays consistent
- API endpoints respond correctly
- Performance is acceptable (<500ms)
- Logging captures all events

---

## Test Sign-Off

- [ ] Scenario 1 ✅ Passed
- [ ] Scenario 2 ✅ Passed
- [ ] Scenario 3 ✅ Passed
- [ ] Scenario 4 ✅ Passed
- [ ] Scenario 5 ✅ Passed
- [ ] Scenario 6 ✅ Passed
- [ ] Scenario 7 ✅ Passed
- [ ] Performance ✅ Acceptable
- [ ] Logging ✅ Complete

**Ready for Production**: Yes / No

**Date Tested**: _______________
**Tester**: _______________
**Notes**: _______________
