# Moolre SMS Quick Start Implementation

Get SMS notifications working in 30 minutes!

## Quick Setup

### Step 1: Get Moolre Credentials

1. Go to https://dashboard.moolre.com (or sign up at https://moolre.com)
2. Get API key from Settings → API Keys
3. Add to `.env.local`:

```env
MOOLRE_API_KEY=your_moolre_api_key_here
MOOLRE_API_URL=https://api.moolre.com/v1
MOOLRE_SENDER_ID=DATAGOD
SMS_ENABLED=true
```

### Step 2: Create SMS Service

Create `lib/sms-service.ts`:

```typescript
import axios from 'axios'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const moolreClient = axios.create({
  baseURL: process.env.MOOLRE_API_URL || 'https://api.moolre.com/v1',
  headers: {
    'Authorization': `Bearer ${process.env.MOOLRE_API_KEY}`,
    'Content-Type': 'application/json'
  }
})

interface SMSPayload {
  phone: string
  message: string
  type: string
  reference?: string
  userId?: string
}

export async function sendSMS(payload: SMSPayload) {
  if (process.env.SMS_ENABLED !== 'true') {
    console.log('[SMS] SMS disabled, skipping:', payload.message)
    return { success: true, skipped: true }
  }

  try {
    console.log('[SMS] Sending to:', payload.phone, payload.message.substring(0, 50))
    
    const response = await moolreClient.post('/sms/send', {
      phone: normalizePhoneNumber(payload.phone),
      message: payload.message,
      senderId: process.env.MOOLRE_SENDER_ID || 'DATAGOD',
      scheduleTime: null
    })

    console.log('[SMS] Success:', response.data.messageId)

    // Log to database
    if (payload.userId) {
      await supabase.from('sms_logs').insert({
        user_id: payload.userId,
        phone_number: payload.phone,
        message: payload.message,
        message_type: payload.type,
        reference_id: payload.reference,
        moolre_message_id: response.data.messageId,
        status: 'sent'
      })
    }

    return {
      success: true,
      messageId: response.data.messageId
    }
  } catch (error) {
    console.error('[SMS] Error:', error)

    // Log failed SMS
    if (payload.userId) {
      await supabase.from('sms_logs').insert({
        user_id: payload.userId,
        phone_number: payload.phone,
        message: payload.message,
        message_type: payload.type,
        reference_id: payload.reference,
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error'
      }).catch(err => console.error('[SMS] Log error:', err))
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send SMS'
    }
  }
}

function normalizePhoneNumber(phone: string): string {
  // Remove spaces, dashes, parentheses
  phone = phone.replace(/[\s\-\(\)]/g, '')
  
  // If starts with 0 (local Ghana format), replace with +233
  if (phone.startsWith('0')) {
    phone = '+233' + phone.substring(1)
  }
  
  // If doesn't have country code, add it
  if (!phone.startsWith('+')) {
    phone = '+233' + phone
  }

  return phone
}

// Template functions
export const SMSTemplates = {
  walletTopUpInitiated: (amount: string, ref: string) =>
    `DATAGOD: Wallet top-up of GHS ${amount} initiated. Ref: ${ref}. Processing...`,
  
  walletTopUpSuccess: (amount: string, balance: string) =>
    `DATAGOD: ✓ Wallet topped up by GHS ${amount}. New balance: GHS ${balance}`,
  
  walletTopUpFailed: (amount: string) =>
    `DATAGOD: ✗ Wallet top-up failed. GHS ${amount}. Try again or contact support.`,
  
  orderCreated: (orderId: string, amount: string) =>
    `DATAGOD: Order #${orderId} created. GHS ${amount}. Awaiting payment.`,
  
  orderPaymentSuccess: (orderId: string) =>
    `DATAGOD: ✓ Payment received for order #${orderId}. Processing...`,
  
  deliveryNotif: (orderId: string) =>
    `DATAGOD: Order #${orderId} delivered. Thank you for shopping!`,
  
  withdrawalApproved: (amount: string, ref: string) =>
    `DATAGOD: Withdrawal approved! GHS ${amount} incoming. Ref: ${ref}`,
  
  withdrawalRejected: (amount: string) =>
    `DATAGOD: Withdrawal request GHS ${amount} rejected. Contact support.`
}
```

### Step 3: Create SMS Logs Table

Run in Supabase SQL editor:

```sql
CREATE TABLE sms_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  phone_number VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  message_type VARCHAR(50),
  reference_id VARCHAR(100),
  moolre_message_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  error_message TEXT,
  sent_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_user_id (user_id),
  INDEX idx_sent_at (sent_at),
  INDEX idx_status (status)
);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON sms_logs TO authenticated;
```

### Step 4: Add SMS to Wallet Top-Up

Update `app/api/payments/initialize/route.ts`:

```typescript
import { sendSMS, SMSTemplates } from '@/lib/sms-service'

// After payment initialization, add:
if (user?.user_metadata?.phone_number) {
  await sendSMS({
    phone: user.user_metadata.phone_number,
    message: SMSTemplates.walletTopUpInitiated(totalAmount.toString(), reference),
    type: 'wallet_topup',
    reference,
    userId
  }).catch(err => console.error('SMS send error:', err))
}
```

### Step 5: Add SMS to Payment Verification

Update `app/api/payments/verify/route.ts`:

```typescript
// After payment verified as successful:
if (verificationResult.status === 'success') {
  const { data: user } = await supabase.auth.admin.getUserById(paymentData.user_id)
  
  if (user?.user_metadata?.phone_number) {
    await sendSMS({
      phone: user.user_metadata.phone_number,
      message: SMSTemplates.walletTopUpSuccess(
        (verificationResult.amount / 100).toString(),
        'GHS 0' // Get actual balance from DB if needed
      ),
      type: 'payment_success',
      reference,
      userId: paymentData.user_id
    }).catch(err => console.error('SMS send error:', err))
  }
}
```

### Step 6: Test

**Test with Moolre sandbox:**

```typescript
// Create test file: app/api/sms/test/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { sendSMS, SMSTemplates } from '@/lib/sms-service'

export async function POST(req: NextRequest) {
  const { phone } = await req.json()
  
  const result = await sendSMS({
    phone,
    message: 'DATAGOD Test SMS: Hello! This is a test message.',
    type: 'test'
  })
  
  return NextResponse.json(result)
}

// Test in browser:
// curl -X POST http://localhost:3000/api/sms/test \
//   -H "Content-Type: application/json" \
//   -d '{"phone": "+233XXXXXXXXX"}'
```

## Implementation Checklist

- [ ] Get Moolre API key
- [ ] Add environment variables
- [ ] Create `lib/sms-service.ts`
- [ ] Create `sms_logs` table
- [ ] Add SMS to wallet top-up
- [ ] Add SMS to payment verification
- [ ] Add SMS to webhook (if using)
- [ ] Test with sandbox
- [ ] Deploy to production
- [ ] Monitor SMS logs

## Common Issues

### SMS Not Sending

**Check:**
1. API key is correct
2. Phone number format: `+233XXXXXXXXX`
3. `SMS_ENABLED=true` in env
4. Account has credit

**Debug:**
```typescript
// Log everything
console.log('[SMS] API URL:', process.env.MOOLRE_API_URL)
console.log('[SMS] API Key:', process.env.MOOLRE_API_KEY?.substring(0, 10))
console.log('[SMS] Phone:', normalizePhoneNumber(phone))
console.log('[SMS] Message:', message)
```

### Invalid Phone Numbers

**Accepted formats:**
- `+233XXXXXXXXX` ✓
- `0XXXXXXXXX` ✓ (auto-converted)
- `233XXXXXXXXX` ✓ (auto-converted)

**Rejected formats:**
- `XXXXXXXXX` ✗ (missing country code)
- `00233XXXXXXXXX` ✗ (double zero)

## Next Steps

1. Add SMS to order notifications
2. Add SMS preferences to user settings
3. Add SMS to withdrawal notifications
4. Monitor usage and optimize
5. Create SMS analytics dashboard

## Cost Tracking

Monitor Moolre dashboard for:
- Monthly SMS volume
- Cost per SMS
- Budget alerts

**Ghana rates:** ~GHS 0.05-0.10 per SMS

---

Ready to start! 🚀
