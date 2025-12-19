# AT-iShare Fulfillment - Data Flow & Columns Quick Reference

## Critical Fix Applied
**Missing columns in fulfillment_logs**: `network` and `phone_number` are NOT NULL but weren't being written.

✅ **FIXED in Commit e8b4c32** - Now both columns are properly populated with order data.

---

## Wallet Orders Flow

### From `/api/orders/purchase`:
```javascript
// Line 12: Receive request with these fields
const { packageId, network, size, price, phoneNumber } = await request.json()
// Example: network = "AT-iShare", phoneNumber = "0201234567"

// Line 79: Create order in orders table
await supabaseAdmin.from("orders").insert([{
  network,                    // "AT-iShare" ← Will be checked for fulfillment
  phone_number: phoneNumber,  // "0201234567" ← Passed to fulfillment
  fulfillment_status: (default "pending")
  // ... other fields
}])

// Line 165-187: Check if fulfillment needed
const fulfillableNetworks = ["AT-iShare", "AT - iShare", "AT-ishare", "at-ishare"]
if (shouldFulfill) {
  atishareService.fulfillOrder({
    phoneNumber,              // ← From request
    sizeGb,                   // ← Parsed from size
    orderId: order[0].id,     // ← From created order
    network: "AT"             // ← Normalized for Code Craft API
  })
}

// In fulfillOrder() → logFulfillment():
// NOW WITH FIX:
logRecord = {
  order_id: orderId,
  network: "AT",              // ✅ NOW POPULATED
  phone_number: phoneNumber,  // ✅ NOW POPULATED
  status: "processing",
  api_response: { ... },
  // ... other fields
}
```

---

## Shop Orders Flow

### From `/api/shop/orders/create`:
```javascript
// Lines 67-75: Insert with these fields
await supabase.from("shop_orders").insert([{
  network,           // "AT-iShare" ← From request
  customer_phone,    // "0201234567" ← From request
  volume_gb,         // Package size
  // ... other fields
}])
```

### From `/api/payments/verify` (Payment Confirmation):
```javascript
// Line 130-136: Select shop order details
const { data: orderDetails } = await supabase
  .from("shop_orders")
  .select("id, network, customer_phone, volume_gb")
  .eq("id", shopOrderData.id)

// Line 138-140: Check if fulfillment needed
if (fulfillableNetworks.some(n => n.toLowerCase() === network.toLowerCase())) {
  atishareService.fulfillOrder({
    phoneNumber: orderDetails.customer_phone,  // ← From shop_orders
    sizeGb: parseInt(orderDetails.volume_gb),  // ← From shop_orders
    orderId: shopOrderData.id,                 // ← Shop order ID
    network: "AT"                              // ← Normalized for Code Craft API
  })
}

// In fulfillOrder() → logFulfillment():
// NOW WITH FIX:
logRecord = {
  order_id: shopOrderData.id,     // ← Shop order ID
  network: "AT",                  // ✅ NOW POPULATED
  phone_number: customer_phone,   // ✅ NOW POPULATED
  status: "processing",
  api_response: { ... },
  // ... other fields
}
```

---

## fulfillment_logs Table Columns

**Required (NOT NULL)**:
- `order_id` ← From either orders.id or shop_orders.id ✅
- `network` ← "AT" or actual network ✅ NOW FIXED
- `phone_number` ← Customer phone ✅ NOW FIXED

**Optional**:
- `status` ← "pending", "processing", "success", "failed"
- `attempt_number` ← Retry count
- `max_attempts` ← Max retries
- `api_response` ← Code Craft API response
- `error_message` ← Error if failed
- `retry_after` ← Next retry timestamp
- `fulfilled_at` ← Completion time
- `created_at` ← Log creation time
- `updated_at` ← Last update time

---

## Verification Query

```sql
-- Check fulfillment logs are being created with all columns
SELECT 
  order_id,
  network,           -- Should NOT be NULL now ✅
  phone_number,      -- Should NOT be NULL now ✅
  status,
  error_message,
  created_at
FROM fulfillment_logs
WHERE network IS NOT NULL  -- Filter for AT-iShare orders
ORDER BY created_at DESC
LIMIT 10;
```

---

**Commit**: e8b4c32
**Status**: ✅ All required columns now being populated correctly
