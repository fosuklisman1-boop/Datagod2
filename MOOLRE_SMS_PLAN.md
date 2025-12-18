# Moolre SMS Notification Implementation Plan

## Overview

Add SMS notifications to key user actions in Datagod using Moolre SMS API:
- Wallet top-up (payment initiated, completed)
- Order purchase (order created, payment confirmed)
- Payment success/failure
- Withdrawal notifications
- Account verification
- Password reset
- Other critical alerts

## Architecture

### 1. SMS Service Layer (`lib/sms-service.ts`)

```typescript
interface SMSPayload {
  phone: string
  message: string
  type: 'wallet_topup' | 'order_purchase' | 'payment_success' | 'withdrawal' | 'verification' | 'alert'
  reference?: string
}

interface SendSMSResponse {
  success: boolean
  messageId?: string
  error?: string
}

// Functions:
- sendSMS(payload: SMSPayload): Promise<SendSMSResponse>
- sendWalletTopUpSMS(userId: string, amount: number)
- sendOrderPurchaseSMS(userId: string, orderId: string)
- sendPaymentSuccessSMS(userId: string, amount: number)
- sendWithdrawalSMS(userId: string, amount: number, status: 'approved' | 'rejected')
```

### 2. Environment Variables

```env
MOOLRE_API_KEY=your_moolre_api_key
MOOLRE_API_URL=https://api.moolre.com/v1
MOOLRE_SENDER_ID=DGOD
SMS_ENABLED=true
```

### 3. SMS Message Templates

Create `lib/sms-templates.ts`:

```typescript
const SMS_TEMPLATES = {
  WALLET_TOPUP_INITIATED: (amount: string, ref: string) => 
    `DATAGOD: Wallet top-up of GHS ${amount} initiated. Ref: ${ref}. Processing...`,
  
  WALLET_TOPUP_SUCCESS: (amount: string, balance: string) =>
    `DATAGOD: Wallet top-up successful! GHS ${amount} added. New balance: GHS ${balance}`,
  
  WALLET_TOPUP_FAILED: (amount: string) =>
    `DATAGOD: Wallet top-up failed. GHS ${amount}. Try again or contact support.`,
  
  ORDER_CREATED: (orderId: string, amount: string) =>
    `DATAGOD: Order #${orderId} created. Amount: GHS ${amount}. Awaiting payment.`,
  
  ORDER_PAYMENT_SUCCESS: (orderId: string, amount: string) =>
    `DATAGOD: Payment received for order #${orderId}. GHS ${amount}. Processing...`,
  
  ORDER_DELIVERED: (orderId: string) =>
    `DATAGOD: Order #${orderId} delivered. Thank you for shopping with us!`,
  
  WITHDRAWAL_APPROVED: (amount: string, ref: string) =>
    `DATAGOD: Withdrawal approved! GHS ${amount} will be transferred. Ref: ${ref}`,
  
  WITHDRAWAL_REJECTED: (amount: string, reason: string) =>
    `DATAGOD: Withdrawal request rejected. GHS ${amount}. Reason: ${reason}`,
  
  VERIFICATION_CODE: (code: string) =>
    `DATAGOD: Your verification code is ${code}. Valid for 10 minutes.`,
  
  PASSWORD_RESET: (link: string) =>
    `DATAGOD: Click to reset password: ${link}. Valid for 1 hour. Don't share!`,
}
```

### 4. Integration Points

#### A. Wallet Top-Up (`app/api/payments/initialize/route.ts`)
```typescript
// After payment initialization
await sendSMS({
  phone: userPhone,
  message: SMS_TEMPLATES.WALLET_TOPUP_INITIATED(amount, reference),
  type: 'wallet_topup',
  reference: reference
})
```

#### B. Payment Verification (`app/api/payments/verify/route.ts`)
```typescript
// After payment verified
if (verificationResult.status === 'success') {
  await sendSMS({
    phone: userPhone,
    message: SMS_TEMPLATES.WALLET_TOPUP_SUCCESS(amount, newBalance),
    type: 'payment_success',
    reference: reference
  })
}
```

#### C. Webhook Payment Success (`app/api/webhooks/paystack/route.ts`)
```typescript
// When charge.success event received
await sendSMS({
  phone: userPhone,
  message: SMS_TEMPLATES.WALLET_TOPUP_SUCCESS(amount, newBalance),
  type: 'payment_success'
})
```

#### D. Order Creation
```typescript
// In order creation endpoint
await sendSMS({
  phone: shopperPhone,
  message: SMS_TEMPLATES.ORDER_CREATED(orderId, amount),
  type: 'order_purchase',
  reference: orderId
})
```

#### E. Order Payment Success
```typescript
// When order payment confirmed
await sendSMS({
  phone: shopperPhone,
  message: SMS_TEMPLATES.ORDER_PAYMENT_SUCCESS(orderId, amount),
  type: 'payment_success'
})

// And notify shop owner
await sendSMS({
  phone: shopOwnerPhone,
  message: `DATAGOD: New order received! Order #${orderId}. GHS ${amount}. Login to respond.`,
  type: 'order_purchase'
})
```

#### F. Withdrawal Status Updates
```typescript
// When withdrawal is approved/rejected
await sendSMS({
  phone: sellerPhone,
  message: status === 'approved' 
    ? SMS_TEMPLATES.WITHDRAWAL_APPROVED(amount, reference)
    : SMS_TEMPLATES.WITHDRAWAL_REJECTED(amount, reason),
  type: 'withdrawal',
  reference: withdrawalId
})
```

### 5. Database Table for SMS Tracking

```sql
CREATE TABLE sms_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  phone_number VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  message_type VARCHAR(50),
  reference_id VARCHAR(100),
  moolre_message_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending', -- pending, sent, failed, delivered
  error_message TEXT,
  sent_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (user_id) REFERENCES auth.users(id),
  INDEX idx_user_id (user_id),
  INDEX idx_phone (phone_number),
  INDEX idx_sent_at (sent_at)
);
```

### 6. Moolre API Integration

```typescript
// lib/moolre.ts
import axios from 'axios'

const moolreClient = axios.create({
  baseURL: process.env.MOOLRE_API_URL,
  headers: {
    'Authorization': `Bearer ${process.env.MOOLRE_API_KEY}`,
    'Content-Type': 'application/json'
  }
})

export async function sendSMSViaaMoolre(
  phone: string,
  message: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const response = await moolreClient.post('/sms/send', {
      phone: normalizePhoneNumber(phone), // +233XXXXXXXXX format
      message,
      senderId: process.env.MOOLRE_SENDER_ID || 'DGOD',
      scheduleTime: null, // Send immediately
    })

    return {
      success: response.status === 200 || response.status === 201,
      messageId: response.data.messageId,
    }
  } catch (error) {
    console.error('[MOOLRE-SMS] Error sending SMS:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send SMS',
    }
  }
}
```

### 7. User Phone Number Storage

Update user metadata in Supabase auth:

```typescript
// When user signs up or updates profile
await supabase.auth.updateUser({
  data: {
    phone_number: '+233XXXXXXXXX',
    sms_notifications_enabled: true,
  }
})
```

Or create dedicated phone table:

```sql
CREATE TABLE user_phone_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id),
  phone_number VARCHAR(20) NOT NULL,
  verified BOOLEAN DEFAULT false,
  verification_code VARCHAR(6),
  verification_code_expires_at TIMESTAMP,
  sms_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_phone (phone_number)
);
```

### 8. SMS Preference Settings

Add to app_settings or user preferences:

```sql
ALTER TABLE app_settings ADD COLUMN sms_notifications_enabled BOOLEAN DEFAULT true;

CREATE TABLE user_sms_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id),
  wallet_topup BOOLEAN DEFAULT true,
  order_updates BOOLEAN DEFAULT true,
  payment_alerts BOOLEAN DEFAULT true,
  withdrawal_updates BOOLEAN DEFAULT true,
  promotional BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

## Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Create SMS service layer (`lib/sms-service.ts`)
- [ ] Set up Moolre API integration
- [ ] Create SMS templates
- [ ] Create sms_logs table
- [ ] Add environment variables

### Phase 2: Wallet Notifications (Week 2)
- [ ] Add SMS on wallet top-up initiation
- [ ] Add SMS on payment success
- [ ] Add SMS on payment failure
- [ ] Test with test phone numbers

### Phase 3: Order Notifications (Week 3)
- [ ] Add SMS on order creation
- [ ] Add SMS on order payment success
- [ ] Add SMS on order delivery
- [ ] Notify shop owners on new orders

### Phase 4: Withdrawal & Other (Week 4)
- [ ] Add SMS on withdrawal approval/rejection
- [ ] Add SMS for account verification
- [ ] Add SMS for password reset
- [ ] User settings for SMS preferences

### Phase 5: Monitoring & Optimization
- [ ] Add SMS delivery tracking
- [ ] Monitor Moolre API usage
- [ ] Set up alerts for failed SMS
- [ ] Analytics dashboard

## Moolre API Details

### Endpoint: `/sms/send`

**Request:**
```json
{
  "phone": "+233XXXXXXXXX",
  "message": "Your SMS message here",
  "senderId": "DATAGOD",
  "scheduleTime": null
}
```

**Response (Success):**
```json
{
  "status": 200,
  "messageId": "msg_123456789",
  "message": "SMS queued successfully"
}
```

**Response (Error):**
```json
{
  "status": 400,
  "error": "Invalid phone number"
}
```

### Phone Number Format
- Must include country code: `+233XXXXXXXXX` (Ghana)
- Remove leading 0 from local numbers: `0XXXXXXXXX` → `+233XXXXXXXXX`
- Validation regex: `/^(\+?233|0)[0-9]{9}$/`

## Testing

### Test Numbers
- Moolre provides test numbers for sandbox environment
- Use test API key for development

### Test Cases
```typescript
// Test wallet top-up SMS
1. User initiates wallet top-up → SMS sent
2. Payment successful → SMS sent with new balance
3. Payment failed → SMS sent with retry link

// Test order SMS
4. User creates order → SMS sent to user & shop owner
5. Order payment confirmed → SMS sent to both

// Test disabled preferences
6. User disables SMS → No SMS sent even on payment
```

## Error Handling

```typescript
// Retry logic for failed SMS
async function sendSMSWithRetry(
  payload: SMSPayload,
  maxRetries: number = 3
): Promise<SendSMSResponse> {
  for (let i = 0; i < maxRetries; i++) {
    const result = await sendSMS(payload)
    if (result.success) return result
    
    console.warn(`[SMS] Retry ${i + 1}/${maxRetries}`)
    await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)))
  }
  
  // Log to database if all retries failed
  await logFailedSMS(payload)
  return { success: false, error: 'Max retries exceeded' }
}
```

## Cost Estimation

**Moolre SMS Rates (Ghana):**
- Outbound SMS: ~GHS 0.05-0.10 per message
- Monthly estimates:
  - 100 users × 5 SMS/month = 500 SMS ≈ GHS 25-50
  - 1000 users × 5 SMS/month = 5000 SMS ≈ GHS 250-500
  - 10000 users × 5 SMS/month = 50000 SMS ≈ GHS 2500-5000

## Security Considerations

1. **Sensitive Data**: Don't include passwords or full card numbers in SMS
2. **Rate Limiting**: Limit SMS per user per hour (e.g., max 10 SMS/hour)
3. **Phone Verification**: Verify phone numbers before sending critical SMS
4. **Audit Trail**: Log all SMS sent for compliance/debugging
5. **GDPR/Privacy**: Honor user preferences and allow opt-out
6. **API Key Security**: Store Moolre API key in `.env` only, never commit

## User Settings UI

Add SMS preference toggle in:
- `/dashboard/settings` → Notifications section
- Wallet page (before top-up)
- Profile/account settings

## Monitoring

Create SMS dashboard showing:
- Total SMS sent today/week/month
- Success rate
- Failed SMS list
- Cost tracking
- Top notification types
- Delivery latency

## Future Enhancements

1. **Two-Factor Authentication**: SMS OTP for login
2. **SMS Templates Admin Panel**: Allow admins to customize messages
3. **Bulk SMS Campaign**: Send promotional SMS to opted-in users
4. **SMS-to-App Bridge**: Users can respond to SMS with commands
5. **WhatsApp Integration**: Use Moolre WhatsApp API alongside SMS
6. **Delivery Reports**: Real-time delivery status tracking
7. **A/B Testing**: Test different message formats for engagement

## References

- Moolre Documentation: https://moolre.com/documentation
- Ghana Phone Number Format: +233 country code
- SMS Best Practices: Keep messages under 160 characters
- Compliance: Ghana NCA regulations for SMS

---

**Status**: Planning Phase  
**Owner**: Development Team  
**Timeline**: 4 weeks  
**Priority**: Medium (Enhancement)
