# AT - iShare Fulfillment Test Checklist

## Current Implementation Status

### ✅ Fulfillment System Complete
- Wallet orders (`/api/orders/purchase`) - Automatically triggers fulfillment for AT - iShare
- Shop orders (`/api/payments/verify`) - Automatically triggers fulfillment after Paystack payment
- Code Craft API request format - Correct (matches API spec)

### ✅ Admin Panel Filtering Complete
- Pending orders tab - AT - iShare orders EXCLUDED
- Download orders - AT - iShare orders EXCLUDED
- Order management - AT - iShare orders handled by fulfillment system only

### ✅ Database Integration Complete
- fulfillment_logs table - Captures all fulfillment attempts
- Columns populated: `network`, `phone_number`, `status`, `api_response`, `error_message`

---

## To Test Fulfillment

### 1. Test Wallet Order Purchase
```
POST /api/orders/purchase
{
  "packageId": "...",
  "network": "AT - iShare",
  "size": "1GB",
  "price": 10,
  "phoneNumber": "0554226398"
}
```

**Expected behavior:**
- Order created in `orders` table
- Fulfillment triggered automatically
- Entry created in `fulfillment_logs` with:
  - `network`: "AT"
  - `phone_number`: "0554226398"
  - `status`: "processing"
  - `api_response`: Code Craft API response

**Check logs for:**
- `[PURCHASE]` - Order creation
- `[CODECRAFT-FULFILL]` - Fulfillment API call
- `[CODECRAFT-LOG]` - Logging to database

### 2. Test Shop Order with Paystack Payment
```
1. Create shop order with AT - iShare package
2. Complete Paystack payment
3. POST /api/payments/verify with payment reference
```

**Expected behavior:**
- Shop order payment status updated to "completed"
- Fulfillment triggered automatically
- Entry created in `fulfillment_logs`

**Check logs for:**
- `[PAYMENT-VERIFY]` - Payment verification
- `[CODECRAFT-FULFILL]` - Fulfillment trigger

### 3. Verify Fulfillment Logs
```sql
SELECT 
  order_id,
  network,
  phone_number,
  status,
  error_message,
  api_response,
  created_at
FROM fulfillment_logs
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```

---

## Code Craft API Request Format (Verified ✓)

Our system sends:
```json
{
  "agent_api": "YOUR_API_KEY",
  "recipient_number": "0554226398",
  "network": "AT",
  "gig": "1",
  "reference_id": "order-uuid-here"
}
```

**Parameters:**
- `agent_api`: API key from environment
- `recipient_number`: Customer phone number
- `network`: "AT" (normalized for Code Craft API)
- `gig`: Data size in GB as string
- `reference_id`: Order ID for tracking

---

## Troubleshooting

### If fulfillment_logs is empty:
1. Check Vercel logs for `[CODECRAFT-FULFILL]` entries
2. Verify API key is correct in environment variables
3. Check `error_message` column if log exists
4. Look for validation errors in logs

### If fulfillment_logs has errors:
1. Check `error_message` field
2. Review `api_response` for Code Craft API error codes:
   - 100: Admin wallet balance is low
   - 101: Service out of stock
   - 102: Agent not found
   - 103: Price not found
   - 555: Network not found

### If orders not triggering fulfillment:
1. Verify network name is exactly "AT - iShare" in database
2. Check `fulfillment_status` column in orders table
3. Look for `[FULFILLMENT]` log prefix

---

## Recent Commits

| Commit | Change |
|--------|--------|
| b00eaf9 | Fixed pending orders filter to use "AT - iShare" |
| dae5ed8 | Restricted fulfillment to AT - iShare only |
| 30caeec | Fixed download filter to use exact network name |
| c17404e | Updated all fulfillment checks to use canonical network name |
| fbcee44 | Fixed fulfillment logging to require network/phone columns |
| cfe9c54 | Improved admin download filter |

---

## Next Steps

1. **Test with real order** - Place AT - iShare order and check fulfillment_logs
2. **Monitor logs** - Watch Vercel logs for fulfillment execution
3. **Verify API key** - Ensure Code Craft API credentials are correct
4. **Check Code Craft API** - Verify endpoint is accessible and responding

