# Paystack Payment Integration

Complete Paystack payment gateway integration for DATAGOD wallet top-ups and transactions.

## Setup Instructions

### 1. Get Paystack Credentials

1. Go to https://paystack.com (or https://dashboard.paystack.com for existing accounts)
2. Sign up for a merchant account
3. Go to **Settings → API Keys & Webhooks**
4. Copy your **Public Key** and **Secret Key**

### 2. Update Environment Variables

Add to `.env.local`:

```env
# Paystack Configuration
NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY=pk_test_your_public_key_here
PAYSTACK_SECRET_KEY=sk_test_your_secret_key_here
```

**Note:** 
- `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` - Exposed to frontend (it's safe)
- `PAYSTACK_SECRET_KEY` - Keep secret, only use on backend

### 3. Configure Webhook

1. In Paystack Dashboard, go to **Settings → API Keys & Webhooks**
2. Scroll to "Webhook URL"
3. Add this webhook URL:
   ```
   https://yourdomain.com/api/webhooks/paystack
   ```
4. Select events to listen for:
   - `charge.success` ✓ (Required)
   - `charge.failed` (Optional)

### 4. Database Setup

Create these tables in Supabase:

#### `wallet_payments`
```sql
CREATE TABLE wallet_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  shop_id UUID,
  amount DECIMAL(10, 2) NOT NULL,
  amount_received DECIMAL(10, 2),
  reference VARCHAR(100) UNIQUE NOT NULL,
  status VARCHAR(50) DEFAULT 'pending', -- pending, processing, completed, failed
  payment_method VARCHAR(50) DEFAULT 'paystack',
  paystack_transaction_id BIGINT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_wallet_payments_user_id ON wallet_payments(user_id);
CREATE INDEX idx_wallet_payments_reference ON wallet_payments(reference);
CREATE INDEX idx_wallet_payments_status ON wallet_payments(status);
```

#### `user_wallets`
```sql
CREATE TABLE user_wallets (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  balance DECIMAL(10, 2) DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'GHS',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

#### `wallet_transactions`
```sql
CREATE TABLE wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  type VARCHAR(50), -- credit, debit, refund
  amount DECIMAL(10, 2) NOT NULL,
  reference VARCHAR(100),
  description TEXT,
  status VARCHAR(50) DEFAULT 'completed',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX idx_wallet_transactions_created_at ON wallet_transactions(created_at);
```

## API Endpoints

### Initialize Payment
**POST** `/api/payments/initialize`

Request body:
```json
{
  "amount": 100,
  "email": "user@example.com",
  "userId": "uuid-of-user",
  "shopId": "optional-shop-id"
}
```

Response:
```json
{
  "success": true,
  "authorizationUrl": "https://checkout.paystack.com/...",
  "accessCode": "access_code",
  "reference": "WALLET-1234567890-ABC123",
  "paymentId": "uuid"
}
```

### Verify Payment
**POST** `/api/payments/verify`

Request body:
```json
{
  "reference": "WALLET-1234567890-ABC123"
}
```

Response:
```json
{
  "success": true,
  "status": "success",
  "amount": 100,
  "reference": "WALLET-1234567890-ABC123",
  "message": "Payment successful! Wallet has been credited."
}
```

### Webhook
**POST** `/api/webhooks/paystack`

Automatically called by Paystack when payment succeeds. No manual action needed.

## Components

### WalletTopUp Component
Location: `components/wallet-top-up.tsx`

Usage:
```tsx
import { WalletTopUp } from "@/components/wallet-top-up"

export default function WalletPage() {
  return (
    <WalletTopUp 
      onSuccess={(amount) => {
        console.log(`Wallet topped up by GHS ${amount}`)
      }}
    />
  )
}
```

Features:
- Amount input with validation
- Quick amount buttons (50, 100, 200, 500)
- Paystack modal integration
- Real-time payment status
- Error handling
- Loading states

## Payment Flow

```
1. User enters amount and clicks "Top Up Wallet"
   ↓
2. Frontend calls POST /api/payments/initialize
   ↓
3. Backend:
   - Creates wallet_payments record (status: pending)
   - Initializes Paystack transaction
   - Returns authorization URL
   ↓
4. Paystack modal opens in browser
   ↓
5a. User completes payment (success path):
    - Frontend calls POST /api/payments/verify
    - Backend credits wallet
    - Wallet updated in database
    - Transaction record created
    ↓
5b. Payment webhook received:
    - Paystack sends charge.success event
    - Webhook endpoint processes it
    - Additional wallet credit (if not already done)
    ↓
6. User sees confirmation and wallet balance updates
```

## Testing

### Test Cards (Test Mode)

| Network | Card Number | Exp | CVC |
|---------|------------|-----|-----|
| Visa | 4111 1111 1111 1111 | 01/25 | 123 |
| Mastercard | 5531 8866 5385 9840 | 01/25 | 123 |
| Verve | 5061 0200 3879 9960 | 01/25 | 123 |

OTP: Use any 6 digits

### Test Webhook

Use Paystack's webhook tester in the dashboard:
1. Go to **Settings → API Keys & Webhooks**
2. Find your webhook URL
3. Click "Test" next to it

## Security Considerations

✅ **Implemented:**
- Secret key never exposed to frontend
- Webhook signature verification
- Transaction reference validation
- Environment variables for credentials
- API rate limiting ready
- Payment status tracking

⚠️ **Additional Recommendations:**
- Implement CORS restrictions
- Add API rate limiting
- Monitor webhook failures
- Implement payment reconciliation
- Add fraud detection
- Use HTTPS in production
- Rotate keys regularly

## Troubleshooting

### Webhook not receiving events
1. Check webhook URL is publicly accessible
2. Verify webhook URL is correct in Paystack dashboard
3. Check `x-paystack-signature` header validation
4. View webhook logs in Paystack dashboard

### Payment initialized but not verifying
1. Ensure PAYSTACK_SECRET_KEY is set correctly
2. Check reference parameter is being passed correctly
3. Verify payment exists in wallet_payments table
4. Check Paystack transaction status directly

### Wallet not being credited
1. Verify webhook endpoint is receiving events
2. Check user_wallets table exists and has user_id record
3. Monitor API logs for errors
4. Verify Paystack secret key is correct

## Production Checklist

- [ ] Switch to Paystack live keys (pk_live_*, sk_live_*)
- [ ] Test end-to-end payment flow with real card
- [ ] Configure webhook URL with production domain
- [ ] Set up monitoring/alerting for payment failures
- [ ] Implement payment reconciliation script
- [ ] Test refund flow if needed
- [ ] Set up customer support process
- [ ] Train support team on payment issues
- [ ] Document payment troubleshooting
- [ ] Backup API keys securely

## Support

For Paystack support: https://support.paystack.com
For API documentation: https://paystack.com/docs/api

---

**Last Updated:** November 26, 2025
**Version:** 1.0
