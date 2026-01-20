# Code Craft Network API Integration - Updated Implementation

## Overview
Updated the fulfillment system to use Code Craft Network API instead of AT-iShare. Now supports MTN, TELECEL, and AT data bundles.

## Environment Variables

Update your `.env.local` with Code Craft credentials:

```env
# Code Craft Network API Configuration
CODECRAFT_API_URL=https://api.codecraftnetwork.com/api
CODECRAFT_API_KEY=your_api_key_here
```

## Authentication
All requests require an API key sent via headers:
```
x-api-key: YOUR_API_KEY
```

## API Integration Details

### Create Order - Regular Packages
**Endpoint**: `POST https://api.codecraftnetwork.com/api/initiate.php`

**Headers**:
```
Content-Type: application/json
x-api-key: YOUR_API_KEY
```

**Request Body**:
```json
{
  "recipient_number": "0554226398",
  "gig": "1",
  "network": "MTN | AT | TELECEL"
}
```

Note: Reference/Order ID is generated automatically by the API.

**Response** (Success):
```json
{
  "status": 200,
  "message": "Order recorded successfully",
  "reference_id": "API0552321442c5ddfe6"
}
```

### Create Order - BigTime Packages
**Endpoint**: `POST https://api.codecraftnetwork.com/api/special.php`

**Request Body**:
```json
{
  "recipient_number": "0554226398",
  "gig": "50",
  "network": "MTN | AT"
}
```

**Response**:
```json
{
  "status": 200,
  "message": "Order recorded successfully",
  "reference_id": "API0552321442c5ddfe6"
}
```

### Status Codes
| Code | Meaning |
|------|---------|
| 200  | Successful |
| 100  | Admin wallet is low |
| 101  | Account out of stock |
| 102  | Agent not found |
| 103  | Price not found |
| 500  | Internal system error |
| 555  | Network not found |

### Check Order Status - Regular Orders
**Endpoint**: `GET https://api.codecraftnetwork.com/api/response_regular.php`

**Request Body**:
```json
{
  "reference_id": "API0552321442c5ddfe6"
}
```

**Response**:
```json
{
  "status": 200,
  "success": true,
  "message": "Order found",
  "data": {
    "beneficiary": "0554226398",
    "gig": "1",
    "network": "MTN",
    "order_date": "Sunday, January 18, 2026",
    "order_time": "23:21:44 PM",
    "price": 4.2,
    "order_status": "Pending"
  }
}
```

### Check Order Status - BigTime Orders
**Endpoint**: `GET https://api.codecraftnetwork.com/api/response_big_time.php`

**Request Body**:
```json
{
  "reference_id": "API0552321442c5ddfe6"
}
```

**Response**:
```json
{
  "status": 200,
  "success": true,
  "message": "Order found",
  "data": {
    "beneficiary": "0554226398",
    "gig": "50",
    "network": "MTN",
    "order_date": "Sunday, January 18, 2026",
    "order_time": "23:21:44 PM",
    "price": 40.0,
    "order_status": "Pending"
  }
}
```

## Code Changes Made

### 1. Updated Service (`lib/at-ishare-service.ts`)
- Changed from AT-iShare API to Code Craft Network API
- Updated environment variable names (CODECRAFT_API_KEY)
- Modified fulfillOrder() to use Code Craft endpoints
- Updated error code handling with Code Craft specific codes
- Modified network validation to support MTN, TELECEL, AT
- Updated verifyFulfillment() to use correct endpoints based on network
- Updated logging prefixes from [AT-ISHARE] to [CODECRAFT]

### 2. Updated API Endpoint (`app/api/orders/fulfillment/route.ts`)
- Now supports MTN, TELECEL, and AT networks
- Maps network names to Code Craft format
- Updated error messages

### 3. Updated Purchase Integration (`app/api/orders/purchase/route.ts`)
- Fulfillment now triggered for MTN, TELECEL, and AT
- Network name normalization for API calls

### 4. Updated Admin Dashboard (`app/dashboard/admin/fulfillment/page.tsx`)
- Changed title to "Data Bundle Fulfillment Manager"
- Updated description to mention all supported networks

## Flow Diagram

```
User Purchases Data Bundle (MTN/TELECEL/AT)
        ↓
Order Created in Database
        ↓
Wallet Deducted
        ↓
Customer Tracked
        ↓
Fulfillment Auto-Triggered
        ↓
Call Code Craft API (initiate.php)
        ↓
API Response: Status 200 (Order Initiated)
        ↓
Fulfillment Status Set to "processing"
        ↓
Admin Can Check Status via response_regular.php
        ↓
When Verified as Successful → Status = "success"
        ↓
User Notified
```

## Network Support

### Currently Supported:
- ✅ **MTN** - Mobile network
- ✅ **TELECEL** - Mobile network
- ✅ **AT** - AT-iShare data bundles

### Response Endpoints:
- MTN, TELECEL, AT → Use `response_regular.php`
- BIG_TIME/BIGTIME → Use `response_big_time.php`

## Error Handling

All error codes are mapped and logged:

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Successful | Mark as processing, verify later |
| 100 | Low wallet | Retry after wallet funded |
| 101 | Out of stock | User should retry later |
| 102 | Agent not found | Configuration issue, contact support |
| 103 | Price not found | Package not available for network |
| 555 | Network not found | Invalid network specified |
| 500 | Server error | Retry with backoff |

## Status Verification

The system will:
1. Mark order as "processing" when initiated with Code Craft
2. Admin can verify status using the admin dashboard
3. Use correct endpoint (regular or bigtime) based on network
4. Update order to "success" when verified delivered

## Testing

### Test with Sample Data

```bash
# Test MTN fulfillment
curl -X POST http://localhost:3000/api/orders/fulfillment \
  -H "Content-Type: application/json" \
  -d '{
    "action": "trigger",
    "orderId": "test-order-id"
  }'

# Check status
curl http://localhost:3000/api/orders/fulfillment?orderId=test-order-id
```

### Expected Flow:
1. Purchase MTN/TELECEL/AT bundle
2. Order created with status "pending"
3. Fulfillment auto-triggers
4. Code Craft API called
5. If successful response (200): status = "processing"
6. Admin can verify status in dashboard
7. When delivery confirmed: status = "success"

## Retry Logic

- Initial attempt: Immediate
- Failed attempt 1→2: Wait 5 minutes
- Failed attempt 2→3: Wait 15 minutes
- Failed attempt 3→4: Wait 1 hour
- Max attempts: 3

## Logging

All operations logged with [CODECRAFT] prefix:

```
[CODECRAFT] Fulfilling order {id} for {phone} - {gb}GB on {network}
[CODECRAFT] Calling API with reference: {id}
[CODECRAFT] API Response status: {status_code}
[CODECRAFT] Order initiated successfully: {id}
[CODECRAFT] API Error: {code} - {message}
[CODECRAFT] Verifying fulfillment for order {id} on {network}
[CODECRAFT] Verification response: {...}
```

## Next Steps

1. ✅ Update environment variables with Code Craft credentials
2. ✅ Test fulfillment with test data
3. ✅ Monitor admin dashboard
4. ✅ Verify order status checks
5. ✅ Deploy to production

All code has been updated and is ready for testing with Code Craft Network API!
