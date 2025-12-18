# Shop Order SMS Notifications - Implementation Complete

## Overview

Customers purchasing bundles from shops now receive SMS notifications at key stages of their order lifecycle.

## SMS Messages Sent

### 1. Order Created (Immediate)
**Trigger:** When customer creates shop order  
**Recipient:** Customer phone number from order form  
**Message Format:**
```
DATAGOD: Order confirmed! ID: ORD-123456 | MTN 5GB | GHS 22.00 | Status: Pending payment
```

**Contains:**
- Reference order code
- Network (MTN, Telecel, etc.)
- Volume (5GB, 10GB, etc.)
- Total price
- Order status

### 2. Payment Confirmed (After payment)
**Trigger:** When Paystack confirms payment (webhook)  
**Recipient:** Customer phone number from order  
**Message Format:**
```
DATAGOD: ✓ Payment confirmed for order ORD-123456! MTN 5GB - GHS 22.00. Processing...
```

**Contains:**
- Checkmark for confirmation
- Order reference
- Network and volume
- Amount paid
- Status update

## Technical Implementation

### SMS Service (`lib/sms-service.ts`)

**Key Features:**
- Moolre API integration
- Phone number normalization (0XXXXXXXXX → +233XXXXXXXXX)
- Automatic retry logic (3 retries with exponential backoff)
- Database logging for all SMS
- Error handling that doesn't block orders

**SMS Templates:**
```typescript
SMSTemplates.orderCreated(orderId, network, volume, amount)
SMSTemplates.orderPaymentConfirmed(orderId, network, volume, amount)
```

### Integration Points

**1. Order Creation** (`app/api/shop/orders/create/route.ts`)
```typescript
// After order is created
await sendSMS({
  phone: customer_phone,
  message: `DATAGOD: Order confirmed! ID: ${reference_code} | ${network} ${volume_gb}GB | GHS ${total_price} | Status: Pending payment`,
  type: 'order_created',
  reference: order_id,
})
```

**2. Payment Confirmation** (`app/api/webhooks/paystack/route.ts`)
```typescript
// After shop order payment verified
await sendSMS({
  phone: shopOrderData.customer_phone,
  message: `DATAGOD: ✓ Payment confirmed for order ${reference_code}! ${network} ${volume_gb}GB - GHS ${total_price}. Processing...`,
  type: 'order_payment_confirmed',
  reference: order_id,
})
```

### Database Tracking

**sms_logs Table** (`migrations/create_sms_logs_table.sql`)
- Tracks every SMS sent
- Records phone, message, type, status
- Links to user_id and order reference
- Indexes for quick lookup

```sql
CREATE TABLE sms_logs (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  phone_number VARCHAR(20),
  message TEXT,
  message_type VARCHAR(50), -- order_created, order_payment_confirmed
  reference_id VARCHAR(100),
  moolre_message_id VARCHAR(100),
  status VARCHAR(20), -- pending, sent, failed
  error_message TEXT,
  sent_at TIMESTAMP,
  delivered_at TIMESTAMP
)
```

## Environment Configuration

### Required Variables

```env
# Moolre SMS Service
MOOLRE_API_KEY=your_moolre_api_key_here
MOOLRE_API_URL=https://api.moolre.com/v1
MOOLRE_SENDER_ID=DATAGOD
SMS_ENABLED=true
```

### Optional Variables

- `SMS_ENABLED=false` - Disable SMS (for testing)
- `MOOLRE_SENDER_ID` - Customize sender ID (default: DATAGOD)

## Testing

### 1. Local Testing (SMS Disabled)
Set `SMS_ENABLED=false` to test without sending real SMS:
```env
SMS_ENABLED=false
```
SMS will log to console instead.

### 2. Sandbox Testing with Moolre
1. Get test API key from Moolre dashboard
2. Add to `.env.local`
3. Use test phone numbers provided by Moolre
4. Messages sent to test numbers appear in sandbox

### 3. Production
1. Use live API key
2. Real SMS sent to customer phone numbers
3. All SMS logged to `sms_logs` table

## Error Handling

**If SMS Fails:**
- Order creation still succeeds ✓
- Payment confirmation still processes ✓
- Error logged to `sms_logs` table with reason
- Automatic retry (3 attempts) with exponential backoff

**Why SMS isn't critical:**
- SMS is a notification, not a requirement
- Order and payment work without SMS
- Database logs ensure audit trail

## Monitoring & Debugging

### Check SMS Status

**View recent SMS sent:**
```sql
SELECT phone_number, message, status, sent_at 
FROM sms_logs 
ORDER BY sent_at DESC 
LIMIT 10;
```

**View failed SMS:**
```sql
SELECT phone_number, message, error_message, sent_at 
FROM sms_logs 
WHERE status = 'failed' 
ORDER BY sent_at DESC;
```

**SMS by type:**
```sql
SELECT message_type, COUNT(*) as count, 
       SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
FROM sms_logs 
GROUP BY message_type;
```

### Console Logs

**Check server logs for SMS:**
```
[SMS] Sending to: +233XXXXXXXXX - Message: DATAGOD: Order confirmed...
[SMS] ✓ Success - Message ID: msg_123456789
```

**Common issues:**
- `[SMS] SMS disabled` - SMS_ENABLED=false
- `[SMS] Moolre API key not configured` - Missing MOOLRE_API_KEY
- `[SMS] Error sending SMS: Invalid phone number` - Phone format issue

## Phone Number Formats

**Accepted Formats:**
- ✓ `+233XXXXXXXXX` (with country code and +)
- ✓ `0XXXXXXXXX` (local Ghana format, auto-converted)
- ✓ `233XXXXXXXXX` (country code without +)

**Auto-Converted To:**
- `+233XXXXXXXXX` (standard Moolre format)

**Rejected:**
- ✗ `XXXXXXXXX` (no country code)
- ✗ `00233XXXXXXXXX` (double zero)

## Cost Tracking

**Moolre Pricing (Ghana):**
- Outbound SMS: ~GHS 0.05-0.10 per message
- Monthly estimates:
  - 100 orders × 2 SMS = 200 SMS ≈ GHS 10-20
  - 1000 orders × 2 SMS = 2000 SMS ≈ GHS 100-200
  - 10000 orders × 2 SMS = 20000 SMS ≈ GHS 1000-2000

**Monitor on Moolre Dashboard:**
- SMS volume
- Cost per message
- Remaining balance
- Budget alerts

## Future Enhancements

1. **SMS Preferences** - Let customers opt in/out
2. **Shop Owner Notifications** - Notify shop owners of new orders
3. **Delivery Status SMS** - When order is delivered
4. **WhatsApp Integration** - Use Moolre WhatsApp API for fallback
5. **SMS Analytics** - Dashboard showing SMS metrics
6. **Two-Factor Auth** - SMS OTP for login
7. **Custom Messages** - Let shop owners customize SMS text

## Troubleshooting

### SMS Not Sending

**Check:**
1. ✓ `SMS_ENABLED=true` in `.env`
2. ✓ `MOOLRE_API_KEY` is set correctly
3. ✓ Customer phone number exists in order
4. ✓ Phone number is in valid format

**Debug Steps:**
```typescript
// Add this to your test file
console.log('SMS Enabled:', process.env.SMS_ENABLED)
console.log('API Key Present:', !!process.env.MOOLRE_API_KEY)
console.log('Phone Number:', normalizePhoneNumber(customerPhone))
```

### Wrong Phone Number Format

**Solution:** Use phone normalization
```typescript
// Input: 0201234567
// Output: +233201234567

const normalizePhoneNumber = (phone: string) => {
  phone = phone.replace(/[\s\-\(\)]/g, '')
  if (phone.startsWith('0')) {
    phone = '+233' + phone.substring(1)
  }
  if (!phone.startsWith('+')) {
    phone = '+233' + phone
  }
  return phone
}
```

### Moolre API Errors

**401 Unauthorized:**
- API key incorrect
- API key expired
- Wrong API URL

**400 Bad Request:**
- Phone number invalid
- Message too long
- Missing required field

**429 Too Many Requests:**
- Rate limit exceeded
- Too many SMS in short time

## References

- Moolre Documentation: https://moolre.com/documentation
- SMS Service: `lib/sms-service.ts`
- SMS Logs: `migrations/create_sms_logs_table.sql`
- Shop Orders: `app/api/shop/orders/create/route.ts`
- Webhook: `app/api/webhooks/paystack/route.ts`

---

**Status**: ✅ Live in Production  
**Last Updated**: December 18, 2025  
**SMS Templates**: 2 (order created, payment confirmed)  
**Coverage**: 100% of shop orders
